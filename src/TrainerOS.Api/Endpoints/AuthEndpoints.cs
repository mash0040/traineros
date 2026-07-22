using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;
using TrainerOS.Domain.Notifications;

namespace TrainerOS.Api.Endpoints;

public static class AuthEndpoints
{
    public sealed record MagicLinkRequest(string? Email);

    public static RouteGroupBuilder MapAuthEndpoints(this RouteGroupBuilder api)
    {
        var auth = api.MapGroup("/auth");
        auth.MapPost("/magic-link", RequestMagicLink);
        return api;
    }

    // api.md: always 202 { ok: true } whether or not the email exists. The response is
    // committed before any lookup/insert/send happens (fire-and-forget below), so there
    // is no enumeration surface via response body OR timing — the expensive work (DB
    // write, email send) can't show up in the request latency of existing emails.
    private static IResult RequestMagicLink(
        MagicLinkRequest body,
        IServiceScopeFactory scopeFactory,
        IConfiguration configuration,
        ILoggerFactory loggerFactory)
    {
        if (string.IsNullOrWhiteSpace(body.Email))
        {
            return Results.BadRequest(ApiError.Create("bad_request", "email is required."));
        }

        var baseUrl = configuration["App:BaseUrl"]
            ?? throw new InvalidOperationException(
                "App:BaseUrl is not configured — magic-link emails cannot be built without the SPA origin.");

        var email = body.Email.Trim();
        var logger = loggerFactory.CreateLogger(typeof(AuthEndpoints).FullName!);

        _ = IssueTokenAsync(scopeFactory, email, baseUrl, logger);

        return Results.Json(new { ok = true }, statusCode: StatusCodes.Status202Accepted);
    }

    private static async Task IssueTokenAsync(
        IServiceScopeFactory scopeFactory, string email, string baseUrl, ILogger logger)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<TrainerOsDbContext>();
            var clock = scope.ServiceProvider.GetRequiredService<TimeProvider>();
            var sender = scope.ServiceProvider.GetRequiredService<INotificationSender>();

            // Any active user gets a link — for the trainer this doubles as password
            // recovery, since v1 has no reset flow. Unknown and deactivated emails fall
            // through to the same silent no-op.
            var user = await db.UserByEmail(email)
                .Where(u => u.IsActive)
                .AsNoTracking()
                .FirstOrDefaultAsync();

            if (user is null)
            {
                return;
            }

            var rawToken = MagicLinkTokens.NewRawToken();
            db.MagicLinkTokens.Add(new MagicLinkToken
            {
                Id = Guid.NewGuid(),
                UserId = user.Id,
                TokenHash = MagicLinkTokens.Hash(rawToken),
                ExpiresAt = clock.GetUtcNow() + MagicLinkTokens.Lifetime,
            });
            await db.SaveChangesAsync();

            var link = $"{baseUrl.TrimEnd('/')}/verify?token={rawToken}";
            await sender.SendAsync(new EmailMessage(
                user.Email,
                "Your TrainerOS login link",
                $"Tap to log in: {link}\nThis link expires in 15 minutes and can only be used once."));
        }
        catch (Exception exception)
        {
            // Post-response by design; the 202 already went out. Failures land in logs,
            // and the user's recourse is requesting another link.
            logger.LogError(exception, "Magic-link issuance failed.");
        }
    }
}
