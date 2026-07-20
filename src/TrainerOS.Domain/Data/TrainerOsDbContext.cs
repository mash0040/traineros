using Microsoft.EntityFrameworkCore;

using TrainerOS.Domain.Entities;

namespace TrainerOS.Domain.Data;

public class TrainerOsDbContext(DbContextOptions<TrainerOsDbContext> options) : DbContext(options)
{
    // Auth tables are the only public sets: they are queried by credential (session id,
    // token hash), which is unguessable and carries no cross-tenant surface.
    public DbSet<MagicLinkToken> MagicLinkTokens => Set<MagicLinkToken>();
    public DbSet<Session> Sessions => Set<Session>();

    // Owned (tenant-bearing) sets are internal on purpose: from outside Domain the only
    // compiling route to this data is the scoped-query extensions, making the safe path
    // the only path (api.md §Authorization model pt 1). Pinned by a reflection test.
    internal DbSet<User> Users => Set<User>();
    internal DbSet<Exercise> Exercises => Set<Exercise>();
    internal DbSet<Program> Programs => Set<Program>();
    internal DbSet<ProgramDay> ProgramDays => Set<ProgramDay>();
    internal DbSet<ProgramDayExercise> ProgramDayExercises => Set<ProgramDayExercise>();
    internal DbSet<WorkoutSession> WorkoutSessions => Set<WorkoutSession>();
    internal DbSet<LoggedSet> LoggedSets => Set<LoggedSet>();
    internal DbSet<NotificationSchedule> NotificationSchedules => Set<NotificationSchedule>();
    internal DbSet<NotificationDelivery> NotificationDeliveries => Set<NotificationDelivery>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasPostgresExtension("citext");

        modelBuilder.Entity<User>(b =>
        {
            b.ToTable("users");
            b.Property(u => u.Id).HasColumnName("id");
            b.Property(u => u.Role).HasColumnName("role");
            b.Property(u => u.Email).HasColumnName("email").HasColumnType("citext");
            b.Property(u => u.DisplayName).HasColumnName("display_name");
            b.Property(u => u.TrainerId).HasColumnName("trainer_id");
            b.Property(u => u.Timezone).HasColumnName("timezone");
            b.Property(u => u.PasswordHash).HasColumnName("password_hash");
            b.Property(u => u.IsActive).HasColumnName("is_active");
            b.Property(u => u.CreatedAt).HasColumnName("created_at");

            b.HasIndex(u => u.Email).IsUnique();

            // Self-referencing FK only — deliberately no CHECK preventing trainer_id = id:
            // the trainer logs their own workouts as a self-client (database.md resolved question 2).
            b.HasOne<User>().WithMany().HasForeignKey(u => u.TrainerId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<MagicLinkToken>(b =>
        {
            b.ToTable("magic_link_tokens");
            b.Property(t => t.Id).HasColumnName("id");
            b.Property(t => t.UserId).HasColumnName("user_id");
            b.Property(t => t.TokenHash).HasColumnName("token_hash");
            b.Property(t => t.ExpiresAt).HasColumnName("expires_at");
            b.Property(t => t.UsedAt).HasColumnName("used_at");

            b.HasIndex(t => t.TokenHash);

            b.HasOne<User>().WithMany().HasForeignKey(t => t.UserId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<Session>(b =>
        {
            b.ToTable("sessions");
            b.Property(s => s.Id).HasColumnName("id");
            b.Property(s => s.UserId).HasColumnName("user_id");
            b.Property(s => s.ExpiresAt).HasColumnName("expires_at");
            b.Property(s => s.CreatedAt).HasColumnName("created_at");
            b.Property(s => s.RevokedAt).HasColumnName("revoked_at");

            b.HasIndex(s => s.UserId);

            b.HasOne<User>().WithMany().HasForeignKey(s => s.UserId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<Exercise>(b =>
        {
            b.ToTable("exercises");
            b.Property(e => e.Id).HasColumnName("id");
            b.Property(e => e.TrainerId).HasColumnName("trainer_id");
            b.Property(e => e.Name).HasColumnName("name");
            b.Property(e => e.VideoUrl).HasColumnName("video_url");
            b.Property(e => e.Cues).HasColumnName("cues");
            b.Property(e => e.IsActive).HasColumnName("is_active");
            b.Property(e => e.CreatedAt).HasColumnName("created_at");

            b.HasOne<User>().WithMany().HasForeignKey(e => e.TrainerId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<Program>(b =>
        {
            b.ToTable("programs");
            b.Property(p => p.Id).HasColumnName("id");
            b.Property(p => p.TrainerId).HasColumnName("trainer_id");
            b.Property(p => p.ClientId).HasColumnName("client_id");
            b.Property(p => p.Title).HasColumnName("title");
            b.Property(p => p.Status).HasColumnName("status");
            b.Property(p => p.StartsOn).HasColumnName("starts_on");
            b.Property(p => p.Notes).HasColumnName("notes");
            b.Property(p => p.CreatedAt).HasColumnName("created_at");
            b.Property(p => p.UpdatedAt).HasColumnName("updated_at");

            // At most one active program per client (database.md §programs rule).
            b.HasIndex(p => p.ClientId).IsUnique().HasFilter("status = 'active'");

            b.HasOne<User>().WithMany().HasForeignKey(p => p.TrainerId).OnDelete(DeleteBehavior.Restrict);
            b.HasOne<User>().WithMany().HasForeignKey(p => p.ClientId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<ProgramDay>(b =>
        {
            b.ToTable("program_days");
            b.Property(d => d.Id).HasColumnName("id");
            b.Property(d => d.ProgramId).HasColumnName("program_id");
            b.Property(d => d.Title).HasColumnName("title");
            b.Property(d => d.Position).HasColumnName("position");

            b.HasOne(d => d.Program).WithMany(p => p.Days).HasForeignKey(d => d.ProgramId).OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<ProgramDayExercise>(b =>
        {
            b.ToTable("program_day_exercises");
            b.Property(e => e.Id).HasColumnName("id");
            b.Property(e => e.ProgramDayId).HasColumnName("program_day_id");
            b.Property(e => e.ExerciseId).HasColumnName("exercise_id");
            b.Property(e => e.Position).HasColumnName("position");
            b.Property(e => e.TargetSets).HasColumnName("target_sets");
            b.Property(e => e.TargetReps).HasColumnName("target_reps");
            b.Property(e => e.TargetLoad).HasColumnName("target_load");
            b.Property(e => e.RestSeconds).HasColumnName("rest_seconds");
            b.Property(e => e.Note).HasColumnName("note");

            b.HasOne(e => e.ProgramDay).WithMany(d => d.Exercises).HasForeignKey(e => e.ProgramDayId).OnDelete(DeleteBehavior.Cascade);
            b.HasOne<Exercise>().WithMany().HasForeignKey(e => e.ExerciseId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<WorkoutSession>(b =>
        {
            b.ToTable("workout_sessions");
            b.Property(s => s.Id).HasColumnName("id");
            b.Property(s => s.TrainerId).HasColumnName("trainer_id");
            b.Property(s => s.ClientId).HasColumnName("client_id");
            b.Property(s => s.ProgramDayId).HasColumnName("program_day_id");
            b.Property(s => s.PerformedOn).HasColumnName("performed_on");
            b.Property(s => s.Comment).HasColumnName("comment");
            b.Property(s => s.CreatedAt).HasColumnName("created_at");

            b.HasIndex(s => new { s.ClientId, s.PerformedOn }).IsDescending(false, true);

            b.HasOne<User>().WithMany().HasForeignKey(s => s.TrainerId).OnDelete(DeleteBehavior.Restrict);
            b.HasOne<User>().WithMany().HasForeignKey(s => s.ClientId).OnDelete(DeleteBehavior.Restrict);
            // SET NULL, not RESTRICT: logs are ground truth (database.md principle 4) —
            // deleting a program day must neither block nor destroy the session logged against it.
            b.HasOne<ProgramDay>().WithMany().HasForeignKey(s => s.ProgramDayId).OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<LoggedSet>(b =>
        {
            b.ToTable("logged_sets");
            b.Property(s => s.Id).HasColumnName("id");
            b.Property(s => s.SessionId).HasColumnName("session_id");
            b.Property(s => s.ExerciseId).HasColumnName("exercise_id");
            b.Property(s => s.ProgramDayExerciseId).HasColumnName("program_day_exercise_id");
            b.Property(s => s.SetNumber).HasColumnName("set_number");
            b.Property(s => s.WeightKg).HasColumnName("weight_kg");
            b.Property(s => s.Reps).HasColumnName("reps");
            b.Property(s => s.LoggedAt).HasColumnName("logged_at");

            b.HasIndex(s => new { s.ExerciseId, s.LoggedAt });

            b.HasOne(s => s.Session).WithMany(w => w.Sets).HasForeignKey(s => s.SessionId).OnDelete(DeleteBehavior.Cascade);
            b.HasOne<Exercise>().WithMany().HasForeignKey(s => s.ExerciseId).OnDelete(DeleteBehavior.Restrict);
            // SET NULL: the set survives prescription deletion via its always-set exercise_id.
            b.HasOne<ProgramDayExercise>().WithMany().HasForeignKey(s => s.ProgramDayExerciseId).OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<NotificationSchedule>(b =>
        {
            b.ToTable("notification_schedules");
            b.Property(s => s.Id).HasColumnName("id");
            b.Property(s => s.TrainerId).HasColumnName("trainer_id");
            b.Property(s => s.ClientId).HasColumnName("client_id");
            b.Property(s => s.Kind).HasColumnName("kind");
            b.Property(s => s.SendTime).HasColumnName("send_time");
            b.Property(s => s.DaysOfWeek).HasColumnName("days_of_week");
            b.Property(s => s.Enabled).HasColumnName("enabled");

            b.HasOne<User>().WithMany().HasForeignKey(s => s.TrainerId).OnDelete(DeleteBehavior.Restrict);
            b.HasOne<User>().WithMany().HasForeignKey(s => s.ClientId).OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<NotificationDelivery>(b =>
        {
            b.ToTable("notification_deliveries");
            b.Property(d => d.Id).HasColumnName("id");
            b.Property(d => d.ScheduleId).HasColumnName("schedule_id");
            b.Property(d => d.UserId).HasColumnName("user_id");
            b.Property(d => d.Channel).HasColumnName("channel");
            b.Property(d => d.ScheduledFor).HasColumnName("scheduled_for");
            b.Property(d => d.IdempotencyKey).HasColumnName("idempotency_key");
            b.Property(d => d.Status).HasColumnName("status");
            b.Property(d => d.Attempts).HasColumnName("attempts");
            b.Property(d => d.LastError).HasColumnName("last_error");
            b.Property(d => d.SentAt).HasColumnName("sent_at");

            // The idempotency mechanism: duplicate scheduler runs become INSERT ... ON CONFLICT no-ops.
            b.HasIndex(d => d.IdempotencyKey).IsUnique();
            b.HasIndex(d => new { d.Status, d.ScheduledFor });

            b.HasOne(d => d.Schedule).WithMany().HasForeignKey(d => d.ScheduleId).OnDelete(DeleteBehavior.Restrict);
            b.HasOne<User>().WithMany().HasForeignKey(d => d.UserId).OnDelete(DeleteBehavior.Restrict);
        });
    }
}
