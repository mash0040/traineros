using System.Reflection;

using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

// The Api project exposes a top-level `Program` class (global namespace) that shadows
// the entity inside this test namespace; the alias disambiguates.
using ProgramEntity = TrainerOS.Domain.Entities.Program;

namespace TrainerOS.Tests;

// api.md §Authorization model / conventions.md data-access rule: ownership is a query
// shape, so these tests seed two full tenants (trainer A + client A, trainer B + client B)
// and assert each scoped extension returns only the caller's rows. SQLite in-memory keeps
// the queries real SQL (joins actually execute) without a Postgres dependency.
public sealed class ScopedQueryExtensionsTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly TrainerOsDbContext _db;

    private readonly Guid _trainerA = Guid.NewGuid();
    private readonly Guid _trainerB = Guid.NewGuid();
    private readonly Guid _clientA = Guid.NewGuid();
    private readonly Guid _clientB = Guid.NewGuid();
    private readonly Guid _exerciseA = Guid.NewGuid();
    private readonly Guid _exerciseB = Guid.NewGuid();
    private readonly Guid _programA = Guid.NewGuid();
    private readonly Guid _programB = Guid.NewGuid();
    private readonly Guid _dayA = Guid.NewGuid();
    private readonly Guid _dayB = Guid.NewGuid();
    private readonly Guid _prescriptionA = Guid.NewGuid();
    private readonly Guid _prescriptionB = Guid.NewGuid();
    private readonly Guid _workoutA = Guid.NewGuid();
    private readonly Guid _workoutB = Guid.NewGuid();
    private readonly Guid _setA = Guid.NewGuid();
    private readonly Guid _setB = Guid.NewGuid();
    private readonly Guid _scheduleA = Guid.NewGuid();
    private readonly Guid _scheduleB = Guid.NewGuid();
    private readonly Guid _deliveryA = Guid.NewGuid();
    private readonly Guid _deliveryB = Guid.NewGuid();

    public ScopedQueryExtensionsTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        var options = new DbContextOptionsBuilder<TrainerOsDbContext>()
            .UseSqlite(_connection)
            .Options;

        _db = new TrainerOsDbContext(options);
        _db.Database.EnsureCreated();
        Seed();
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    private void Seed()
    {
        SeedTenant(_trainerA, _clientA, "a", _exerciseA, _programA, _dayA, _prescriptionA, _workoutA, _setA, _scheduleA, _deliveryA);
        SeedTenant(_trainerB, _clientB, "b", _exerciseB, _programB, _dayB, _prescriptionB, _workoutB, _setB, _scheduleB, _deliveryB);
        _db.SaveChanges();
        _db.ChangeTracker.Clear();
    }

    private void SeedTenant(
        Guid trainerId, Guid clientId, string tag, Guid exerciseId, Guid programId, Guid dayId,
        Guid prescriptionId, Guid workoutId, Guid setId, Guid scheduleId, Guid deliveryId)
    {
        var now = DateTimeOffset.UtcNow;

        _db.Add(new User
        {
            Id = trainerId, Role = "trainer", Email = $"trainer-{tag}@example.com",
            DisplayName = $"Trainer {tag}", Timezone = "America/Toronto", IsActive = true, CreatedAt = now,
        });
        _db.Add(new User
        {
            Id = clientId, Role = "client", Email = $"client-{tag}@example.com",
            DisplayName = $"Client {tag}", TrainerId = trainerId, Timezone = "America/Toronto",
            IsActive = true, CreatedAt = now,
        });
        _db.Add(new Exercise
        {
            Id = exerciseId, TrainerId = trainerId, Name = $"Squat {tag}", IsActive = true, CreatedAt = now,
        });
        _db.Add(new ProgramEntity
        {
            Id = programId, TrainerId = trainerId, ClientId = clientId, Title = $"Block {tag}",
            Status = "active", CreatedAt = now, UpdatedAt = now,
        });
        _db.Add(new ProgramDay
        {
            Id = dayId, ProgramId = programId, Title = "Day A", Position = 1,
        });
        _db.Add(new ProgramDayExercise
        {
            Id = prescriptionId, ProgramDayId = dayId, ExerciseId = exerciseId,
            Position = 1, TargetSets = 3, TargetReps = "8-10",
        });
        _db.Add(new WorkoutSession
        {
            Id = workoutId, TrainerId = trainerId, ClientId = clientId, ProgramDayId = dayId,
            PerformedOn = new DateOnly(2026, 7, 20), CreatedAt = now,
        });
        _db.Add(new LoggedSet
        {
            Id = setId, SessionId = workoutId, ExerciseId = exerciseId, ProgramDayExerciseId = prescriptionId,
            SetNumber = 1, WeightKg = 100m, Reps = 8, LoggedAt = now,
        });
        _db.Add(new NotificationSchedule
        {
            Id = scheduleId, TrainerId = trainerId, ClientId = clientId, Kind = "workout_reminder",
            SendTime = new TimeOnly(7, 0), DaysOfWeek = [1, 3, 5], Enabled = true,
        });
        _db.Add(new NotificationDelivery
        {
            Id = deliveryId, ScheduleId = scheduleId, UserId = clientId, Channel = "email",
            ScheduledFor = now, IdempotencyKey = $"{scheduleId}:2026-07-20", Status = "pending", Attempts = 0,
        });
    }

    // -- Trainer scope --

    [Fact]
    public void ClientsForTrainer_returns_only_that_trainers_clients()
    {
        var ids = _db.ClientsForTrainer(_trainerA).Select(u => u.Id).ToList();
        Assert.Equal([_clientA], ids);
    }

    [Fact]
    public void ExercisesForTrainer_excludes_other_trainers_library()
    {
        var ids = _db.ExercisesForTrainer(_trainerA).Select(e => e.Id).ToList();
        Assert.Equal([_exerciseA], ids);
    }

    [Fact]
    public void ProgramsForTrainer_excludes_other_trainers_programs()
    {
        var ids = _db.ProgramsForTrainer(_trainerA).Select(p => p.Id).ToList();
        Assert.Equal([_programA], ids);
    }

    [Fact]
    public void ProgramDaysForTrainer_scopes_through_program_join()
    {
        var ids = _db.ProgramDaysForTrainer(_trainerA).Select(d => d.Id).ToList();
        Assert.Equal([_dayA], ids);
    }

    [Fact]
    public void ProgramDayExercisesForTrainer_scopes_through_day_and_program_join()
    {
        var ids = _db.ProgramDayExercisesForTrainer(_trainerA).Select(e => e.Id).ToList();
        Assert.Equal([_prescriptionA], ids);
    }

    [Fact]
    public void WorkoutSessionsForTrainer_excludes_other_trainers_sessions()
    {
        var ids = _db.WorkoutSessionsForTrainer(_trainerA).Select(s => s.Id).ToList();
        Assert.Equal([_workoutA], ids);
    }

    [Fact]
    public void LoggedSetsForTrainer_scopes_through_session_join()
    {
        var ids = _db.LoggedSetsForTrainer(_trainerA).Select(s => s.Id).ToList();
        Assert.Equal([_setA], ids);
    }

    [Fact]
    public void NotificationSchedulesForTrainer_excludes_other_trainers_schedules()
    {
        var ids = _db.NotificationSchedulesForTrainer(_trainerA).Select(s => s.Id).ToList();
        Assert.Equal([_scheduleA], ids);
    }

    [Fact]
    public void NotificationDeliveriesForTrainer_scopes_through_schedule_join()
    {
        var ids = _db.NotificationDeliveriesForTrainer(_trainerA).Select(d => d.Id).ToList();
        Assert.Equal([_deliveryA], ids);
    }

    // -- Client scope --

    [Fact]
    public void ProgramsForClient_excludes_other_clients_programs()
    {
        var ids = _db.ProgramsForClient(_clientA).Select(p => p.Id).ToList();
        Assert.Equal([_programA], ids);
    }

    [Fact]
    public void ProgramDaysForClient_scopes_through_program_join()
    {
        var ids = _db.ProgramDaysForClient(_clientA).Select(d => d.Id).ToList();
        Assert.Equal([_dayA], ids);
    }

    [Fact]
    public void ProgramDayExercisesForClient_scopes_through_day_and_program_join()
    {
        var ids = _db.ProgramDayExercisesForClient(_clientA).Select(e => e.Id).ToList();
        Assert.Equal([_prescriptionA], ids);
    }

    [Fact]
    public void WorkoutSessionsForClient_excludes_other_clients_sessions()
    {
        var ids = _db.WorkoutSessionsForClient(_clientA).Select(s => s.Id).ToList();
        Assert.Equal([_workoutA], ids);
    }

    [Fact]
    public void LoggedSetsForClient_scopes_through_session_join()
    {
        var ids = _db.LoggedSetsForClient(_clientA).Select(s => s.Id).ToList();
        Assert.Equal([_setA], ids);
    }

    [Fact]
    public void NotificationSchedulesForClient_excludes_other_clients_schedules()
    {
        var ids = _db.NotificationSchedulesForClient(_clientA).Select(s => s.Id).ToList();
        Assert.Equal([_scheduleA], ids);
    }

    // -- Auth accessor --

    [Fact]
    public void UserByEmail_and_UserById_resolve_a_single_identity()
    {
        Assert.Equal(_clientA, Assert.Single(_db.UserByEmail("client-a@example.com")).Id);
        Assert.Equal(_trainerB, Assert.Single(_db.UserById(_trainerB)).Id);
    }

    // -- The invariants the AC calls out --

    [Fact]
    public void Existing_row_outside_scope_is_indistinguishable_from_nonexistent()
    {
        // api.md pt 2: client A asking for client B's set by id gets nothing — the
        // scoped query returns null exactly as it would for a made-up id (→ 404).
        var nonexistentId = Guid.NewGuid();
        var other = _db.LoggedSetsForClient(_clientA).FirstOrDefault(s => s.Id == _setB);
        var madeUp = _db.LoggedSetsForClient(_clientA).FirstOrDefault(s => s.Id == nonexistentId);

        Assert.Null(other);
        Assert.Null(madeUp);
        Assert.NotNull(_db.Find<LoggedSet>(_setB)); // the row does exist
    }

    [Fact]
    public void LoggedSetsForClient_verifies_the_chain_by_join_in_one_query()
    {
        // api.md pt 3: ownership of logged_sets goes through workout_sessions in the
        // same SQL statement, not a separate parent lookup.
        var sql = _db.LoggedSetsForClient(_clientA).ToQueryString();

        Assert.Contains("JOIN", sql);
        Assert.Contains("workout_sessions", sql);
    }

    [Fact]
    public void ProgramDayExercisesForClient_verifies_the_chain_by_join_in_one_query()
    {
        var sql = _db.ProgramDayExercisesForClient(_clientA).ToQueryString();

        Assert.Contains("JOIN", sql);
        Assert.Contains("program_days", sql);
        Assert.Contains("programs", sql);
    }

    [Fact]
    public void DbContext_exposes_no_public_DbSet_of_owned_entity_types()
    {
        // Tripwire for the enforcement design: owned (tenant-bearing) data must not be
        // reachable from Api/Functions except through the scoped-query extensions. Only
        // the credential-keyed auth tables may surface as public DbSets. If this fails,
        // someone widened the DbContext — that is a security-model change, not a refactor.
        Type[] authOnly = [typeof(Session), typeof(MagicLinkToken)];

        var publicSetTypes = typeof(TrainerOsDbContext)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.PropertyType.IsGenericType
                && p.PropertyType.GetGenericTypeDefinition() == typeof(DbSet<>))
            .Select(p => p.PropertyType.GetGenericArguments()[0])
            .ToList();

        Assert.All(publicSetTypes, t => Assert.Contains(t, authOnly));
    }
}
