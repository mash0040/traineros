using Microsoft.EntityFrameworkCore;

using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

namespace TrainerOS.Api.Auth;

// Creates the server-side session row and its cookie on login (database.md §sessions).
// Consumed by the auth endpoints (#21 magic-link verify, #22 trainer login).
public sealed class SessionService(TrainerOsDbContext db, TimeProvider clock)
{
    // api.md §Auth: 90-day expiry for clients, 30 for trainer.
    public static readonly TimeSpan ClientLifetime = TimeSpan.FromDays(90);
    public static readonly TimeSpan TrainerLifetime = TimeSpan.FromDays(30);

    public async Task<Session> SignInAsync(HttpContext context, User user, CancellationToken cancellationToken = default)
    {
        var now = clock.GetUtcNow();
        var session = new Session
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            CreatedAt = now,
            ExpiresAt = now + (user.Role == Roles.Trainer ? TrainerLifetime : ClientLifetime),
        };

        db.Sessions.Add(session);
        await db.SaveChangesAsync(cancellationToken);

        SessionCookie.Append(context.Response, session.Id, session.ExpiresAt);
        return session;
    }

    // Idempotent: revokes the request's session row if there is one, always clears the
    // cookie. Logging out twice (or with a dead cookie) is a success, not an error.
    public async Task SignOutAsync(HttpContext context, CancellationToken cancellationToken = default)
    {
        if (context.Request.Cookies.TryGetValue(SessionCookie.Name, out var raw)
            && Guid.TryParse(raw, out var sessionId))
        {
            await db.Sessions
                .Where(s => s.Id == sessionId && s.RevokedAt == null)
                .ExecuteUpdateAsync(
                    s => s.SetProperty(x => x.RevokedAt, clock.GetUtcNow()), cancellationToken);
        }

        SessionCookie.Delete(context.Response);
    }
}
