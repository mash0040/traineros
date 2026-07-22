using System.Threading.RateLimiting;

using Microsoft.AspNetCore.RateLimiting;

namespace TrainerOS.Api.Auth;

// api.md §magic-link: 3 requests / email / 15 min and 10 / IP / hour — v1-sized, Redis-free.
// The IP window also covers POST /login: Argon2 caps guessing throughput on its own, but
// the shared backstop costs nothing and closes the surface. Per-email limiting stays
// magic-link-only — a per-email login lockout would be an account-DoS button.
// Counters live in process memory (ASP.NET Core's built-in limiters): they reset on every
// restart/redeploy, and scaling beyond one App Service instance would multiply each limit
// by the instance count. Acceptable for v1's single always-on instance; revisit storage
// only if the deployment shape changes. Scope per api.md §Cross-cutting: auth (and pause,
// epic #6) endpoints only — nothing else gets rate limiting in v1.
public static class AuthRateLimiting
{
    public const string MagicLinkIpPolicy = "magic-link-ip";

    public static readonly ApiError RateLimitedError =
        ApiError.Create("rate_limited", "Too many requests. Try again later.");

    public static IServiceCollection AddAuthRateLimiting(this IServiceCollection services)
    {
        services.AddSingleton<MagicLinkEmailLimiter>();
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.OnRejected = static async (context, cancellationToken) =>
                await context.HttpContext.Response.WriteAsJsonAsync(RateLimitedError, cancellationToken);
            options.AddPolicy(MagicLinkIpPolicy, context =>
                RateLimitPartition.GetFixedWindowLimiter(
                    context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 10,
                        Window = TimeSpan.FromHours(1),
                        QueueLimit = 0,
                    }));
        });
        return services;
    }
}

// Keys on the submitted email string whether or not it maps to a user — limiting only
// known emails would turn the 429 into an account-existence oracle. Lowercased so case
// variants of one address share a window. Checked in the handler (not middleware policy)
// because the email lives in the JSON body, which partition selectors can't read.
public sealed class MagicLinkEmailLimiter : IDisposable
{
    private readonly PartitionedRateLimiter<string> _limiter =
        PartitionedRateLimiter.Create<string, string>(static email =>
            RateLimitPartition.GetFixedWindowLimiter(email, static _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 3,
                Window = TimeSpan.FromMinutes(15),
                QueueLimit = 0,
            }));

    public bool TryAcquire(string email)
    {
        using var lease = _limiter.AttemptAcquire(email.ToLowerInvariant());
        return lease.IsAcquired;
    }

    public void Dispose() => _limiter.Dispose();
}
