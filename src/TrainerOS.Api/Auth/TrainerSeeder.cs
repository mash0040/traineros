using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

namespace TrainerOS.Api.Auth;

// Answers "how does the first trainer account exist" (#24): from configuration, never
// from a migration. In deployment these arrive as environment variables
// (Seed__TrainerEmail / Seed__TrainerPassword — App Service configuration); no secrets
// in the repo per architecture.md.
public static class TrainerSeeder
{
    public static async Task SeedAsync(IServiceProvider services, IConfiguration configuration)
    {
        var email = configuration["Seed:TrainerEmail"];
        var password = configuration["Seed:TrainerPassword"];

        if (email is null && password is null)
        {
            return; // seed not requested; the common case after first deploy
        }

        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(password))
        {
            throw new InvalidOperationException(
                "Seed:TrainerEmail and Seed:TrainerPassword must both be set to seed the trainer account "
                + "(or both unset to skip seeding). Refusing to start half-configured.");
        }

        // #114: the same check the client roster does, for the same reason and one worse.
        // A typo here seeds the account that owns every client, and the symptom is a login
        // link that never arrives with nothing in the logs to say why. Failing at boot
        // matches how Program.cs already treats a missing pause-token key: a misconfiguration
        // should stop the app, not surface later as somebody's broken link.
        if (!EmailAddresses.IsValid(email.Trim()))
        {
            throw new InvalidOperationException(
                $"Seed:TrainerEmail ('{email}') is not a valid email address. The trainer account "
                + "cannot receive a login link at an address that does not parse.");
        }

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TrainerOsDbContext>();
        var clock = scope.ServiceProvider.GetRequiredService<TimeProvider>();
        var logger = scope.ServiceProvider.GetRequiredService<ILoggerFactory>()
            .CreateLogger(typeof(TrainerSeeder).FullName!);

        // Idempotence: one trainer in v1 — if any trainer exists, never duplicate and
        // never overwrite (a re-run with a different password is a no-op, not a reset).
        if (await db.TrainerAccountExistsAsync())
        {
            logger.LogInformation("Trainer account already exists; seed skipped.");
            return;
        }

        db.Add(new User
        {
            Id = Guid.NewGuid(),
            Role = Roles.Trainer,
            Email = email.Trim(),
            DisplayName = "Trainer",
            Timezone = "America/Toronto",
            // weight_unit is left to its default: the trainer has no logging surface, so the
            // value is never read for this row.
            PasswordHash = Passwords.Hash(password),
            IsActive = true,
            CreatedAt = clock.GetUtcNow(),
        });
        await db.SaveChangesAsync();

        logger.LogInformation("Seeded initial trainer account for {Email}.", email);
    }
}
