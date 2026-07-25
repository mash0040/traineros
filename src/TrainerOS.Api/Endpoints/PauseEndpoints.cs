using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Notifications;

namespace TrainerOS.Api.Endpoints;

// api.md §Pause endpoints: unauthenticated and token-bearing. The client following this
// link from an email has no session — the signed token is the whole authorization, and it
// authorizes exactly one thing: disabling one schedule.
//
// The two-step shape is the third application of the doc-wide no-state-change-on-GET rule
// (magic-link verify #21, api.md §GET /api/auth/verify). Mail scanners and link prefetchers
// issue GETs before the recipient ever opens the message, so a one-click GET would silently
// pause reminders for every client behind a scanning mail provider. GET answers "is this
// link good?"; the button the client actually presses is a POST.
//
// Re-enabling is the trainer's job through PATCH /api/schedules/:id — deliberately not a
// second token flow, because v1's preference model is one toggle.
public static class PauseEndpoints
{
    public sealed record PauseRequest(string? Token);

    public static RouteGroupBuilder MapPauseEndpoints(this RouteGroupBuilder api)
    {
        // api.md §Cross-cutting: pause inherits the auth endpoints' 10/IP/hour policy. An
        // unauthenticated endpoint that writes needs the same backstop the login path has.
        api.MapGet("/pause", ValidateToken).RequireRateLimiting(AuthRateLimiting.MagicLinkIpPolicy);
        api.MapPost("/pause", ConsumeToken).RequireRateLimiting(AuthRateLimiting.MagicLinkIpPolicy);
        return api;
    }

    // Renders/validates only. No writes here, ever — that is the entire point of the split.
    // Shape mirrors GET /api/auth/verify's { valid } so the SPA's two token screens branch
    // the same way.
    private static async Task<IResult> ValidateToken(
        string? token,
        TrainerOsDbContext db,
        PauseTokenSigner signer,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var scheduleId = signer.Validate(token, clock.GetUtcNow());
        if (scheduleId is null)
        {
            return Results.Ok(new { valid = false });
        }

        // A perfectly-signed token for a schedule that has since been deleted is not a
        // usable link. Report it exactly like a bad signature: the holder of the link
        // learns nothing about which schedules exist.
        var exists = await db.ScheduleForPause(scheduleId.Value)
            .AsNoTracking()
            .AnyAsync(cancellationToken);

        return Results.Ok(new { valid = exists });
    }

    private static async Task<IResult> ConsumeToken(
        PauseRequest body,
        TrainerOsDbContext db,
        PauseTokenSigner signer,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var scheduleId = signer.Validate(body.Token, clock.GetUtcNow());
        if (scheduleId is null)
        {
            return InvalidToken();
        }

        // One statement, no read-then-write: the token already established which row, and
        // pausing an already-paused schedule is a no-op rather than an error. A prefetcher
        // that somehow replays the POST changes nothing the first press didn't.
        var paused = await db.ScheduleForPause(scheduleId.Value)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.Enabled, false), cancellationToken);

        return paused == 0 ? InvalidToken() : Results.Ok(new { ok = true });
    }

    // Same indistinguishable rejection as #21's POST /api/auth/verify: invalid signature,
    // expired, and vanished schedule are one 401 with one message. No validity oracle.
    private static IResult InvalidToken() => Results.Json(
        ApiError.Create("invalid_token", "This pause link is invalid or expired."),
        statusCode: StatusCodes.Status401Unauthorized);
}
