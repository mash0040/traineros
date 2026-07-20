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
}
