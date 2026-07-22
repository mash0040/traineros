using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;
using TrainerOS.Domain.Notifications;

namespace TrainerOS.Api.Endpoints;

public static class AuthEndpoints
{
    public sealed record MagicLinkRequest(string? Email);
    public sealed record VerifyRequest(string? Token);
    public sealed record LoginRequest(string? Email, string? Password);

    // Verified against when the email doesn't resolve to a trainer, so unknown-email and
    // wrong-password rejections cost the same Argon2 work — no timing enumeration.
    private static readonly string DummyPasswordHash = Passwords.Hash(Guid.NewGuid().ToString());

    public static RouteGroupBuilder MapAuthEndpoints(this RouteGroupBuilder api)
    {
        var auth = api.MapGroup("/auth");
        auth.MapPost("/magic-link", RequestMagicLink)
            .RequireRateLimiting(AuthRateLimiting.MagicLinkIpPolicy);
        auth.MapGet("/verify", ValidateToken);
        auth.MapPost("/verify", ConsumeToken);
        auth.MapPost("/login", Login)
            .RequireRateLimiting(AuthRateLimiting.MagicLinkIpPolicy);
        auth.MapPost("/logout", Logout);
        return api;
    }

    // api.md §POST /api/auth/login: trainer only; Argon2id comparison; one
    // indistinguishable "invalid credentials" rejection for unknown email, wrong
    // password, client email (clients have no password), or deactivated account.
    private static async Task<IResult> Login(
        LoginRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        SessionService sessions,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(body.Email) || string.IsNullOrWhiteSpace(body.Password))
        {
            return Results.BadRequest(ApiError.Create("bad_request", "email and password are required."));
        }

        var user = await db.UserByEmail(body.Email.Trim())
            .Where(u => u.IsActive && u.Role == Roles.Trainer)
            .AsNoTracking()
            .FirstOrDefaultAsync(cancellationToken);

        var passwordMatches = Passwords.Verify(body.Password, user?.PasswordHash ?? DummyPasswordHash);
        if (user is null || user.PasswordHash is null || !passwordMatches)
        {
            return Results.Json(
                ApiError.Create("invalid_credentials", "Invalid credentials."),
                statusCode: StatusCodes.Status401Unauthorized);
        }

        await sessions.SignInAsync(http, user, cancellationToken);
        return Results.Ok(new { ok = true });
    }

    private static async Task<IResult> Logout(
        HttpContext http, SessionService sessions, CancellationToken cancellationToken)
    {
        await sessions.SignOutAsync(http, cancellationToken);
        return Results.Ok(new { ok = true });
    }

    // api.md §GET /api/auth/verify: renders/validates ONLY — mail scanners GET links
    // before the user does, so consumption is POST-only. This handler performs no writes
    // (the doc-wide no-state-change-on-GET invariant is anchored here).
    private static async Task<IResult> ValidateToken(
        string? token, TrainerOsDbContext db, TimeProvider clock, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return Results.Ok(new { valid = false });
        }

        var found = await FindLiveTokenAsync(db, token, clock.GetUtcNow(), cancellationToken);
        return Results.Ok(new { valid = found is not null });
    }

    private static async Task<IResult> ConsumeToken(
        VerifyRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        TimeProvider clock,
        SessionService sessions,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(body.Token))
        {
            return Results.BadRequest(ApiError.Create("bad_request", "token is required."));
        }

        var now = clock.GetUtcNow();
        var found = await FindLiveTokenAsync(db, body.Token, now, cancellationToken);
        if (found is null)
        {
            return InvalidToken();
        }

        // Single-use, enforced atomically: the conditional update wins for exactly one
        // caller — a concurrent double-POST of the same link gets zero rows here.
        var consumed = await db.MagicLinkTokens
            .Where(t => t.Id == found.Value.Token.Id && t.UsedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.UsedAt, now), cancellationToken);

        if (consumed == 0)
        {
            return InvalidToken();
        }

        await sessions.SignInAsync(http, found.Value.User, cancellationToken);
        return Results.Ok(new { ok = true });

        static IResult InvalidToken() => Results.Json(
            ApiError.Create("invalid_token", "This login link is invalid, expired, or already used."),
            statusCode: StatusCodes.Status401Unauthorized);
    }

    // Hash-compared lookup (raw tokens are never stored), then expiry/used/active checks.
    // Trainer tokens are as valid as client tokens: the magic link doubles as the
    // trainer's v1 password recovery (#20); SessionService applies the 30-day lifetime.
    private static async Task<(MagicLinkToken Token, User User)?> FindLiveTokenAsync(
        TrainerOsDbContext db, string rawToken, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var hash = MagicLinkTokens.Hash(rawToken);
        var token = await db.MagicLinkTokens.AsNoTracking()
            .FirstOrDefaultAsync(t => t.TokenHash == hash, cancellationToken);

        if (token is null || token.UsedAt is not null || token.ExpiresAt <= now)
        {
            return null;
        }

        var user = await db.UserById(token.UserId)
            .Where(u => u.IsActive)
            .AsNoTracking()
            .FirstOrDefaultAsync(cancellationToken);

        return user is null ? null : (token, user);
    }

    // api.md: always 202 { ok: true } whether or not the email exists. The response is
    // committed before any lookup/insert/send happens (fire-and-forget below), so there
    // is no enumeration surface via response body OR timing — the expensive work (DB
    // write, email send) can't show up in the request latency of existing emails.
    private static IResult RequestMagicLink(
        MagicLinkRequest body,
        MagicLinkEmailLimiter emailLimiter,
        IServiceScopeFactory scopeFactory,
        IConfiguration configuration,
        ILoggerFactory loggerFactory)
    {
        if (string.IsNullOrWhiteSpace(body.Email))
        {
            return Results.BadRequest(ApiError.Create("bad_request", "email is required."));
        }

        if (!emailLimiter.TryAcquire(body.Email.Trim()))
        {
            return Results.Json(
                AuthRateLimiting.RateLimitedError,
                statusCode: StatusCodes.Status429TooManyRequests);
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
