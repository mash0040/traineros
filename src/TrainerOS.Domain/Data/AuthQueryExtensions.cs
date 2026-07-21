using TrainerOS.Domain.Entities;

namespace TrainerOS.Domain.Data;

// The intentional public path to users for auth flows only: identity resolution by a
// unique credential-shaped key (login email, session's user id). Tenant-shaped access
// to users goes through ScopedQueryExtensions.ClientsForTrainer — never here.
public static class AuthQueryExtensions
{
    public static IQueryable<User> UserById(this TrainerOsDbContext db, Guid userId)
        => db.Users.Where(u => u.Id == userId);

    public static IQueryable<User> UserByEmail(this TrainerOsDbContext db, string email)
        => db.Users.Where(u => u.Email == email);

    /// <summary>
    /// Resolves the user behind a session in one query, excluding soft-deactivated users
    /// (a deactivated client must not stay logged in). Expiry and revocation come back as
    /// data for the caller to evaluate — DateTimeOffset comparisons don't translate on
    /// every provider (SQLite in tests), and the clock belongs to the caller anyway.
    /// </summary>
    public static IQueryable<AuthenticatedSession> UserBySession(this TrainerOsDbContext db, Guid sessionId)
        => from s in db.Sessions
           where s.Id == sessionId
           join u in db.Users on s.UserId equals u.Id
           where u.IsActive
           select new AuthenticatedSession(u, s.ExpiresAt, s.RevokedAt);
}

public sealed record AuthenticatedSession(User User, DateTimeOffset ExpiresAt, DateTimeOffset? RevokedAt);
