using Microsoft.EntityFrameworkCore;

using TrainerOS.Domain.Data;

namespace TrainerOS.Api.Auth;

// Resolves the session cookie to a user and attaches it to the request. Read-only by
// design: no sliding expiry, no last-seen writes — a GET through this pipeline changes
// no state (api.md doc-wide invariant). Anything invalid (missing, malformed, expired,
// revoked, deactivated user) just leaves the request anonymous; role gates turn that
// into a 404 at the endpoint.
public sealed class SessionAuthMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, TrainerOsDbContext db, TimeProvider clock)
    {
        if (context.Request.Cookies.TryGetValue(SessionCookie.Name, out var raw)
            && Guid.TryParse(raw, out var sessionId))
        {
            var authenticated = await db.UserBySession(sessionId)
                .AsNoTracking()
                .FirstOrDefaultAsync(context.RequestAborted);

            if (authenticated is { RevokedAt: null } && authenticated.ExpiresAt > clock.GetUtcNow())
            {
                context.SetCurrentUser(authenticated.User);
            }
        }

        await next(context);
    }
}
