using TrainerOS.Domain.Entities;

namespace TrainerOS.Domain.Data;

// api.md §Authorization model: scoped queries, not load-then-check. Ownership lives in the
// WHERE clause of every query; a scoped query that finds nothing is a 404. Nested chains
// (logged_sets → workout_session → client) are verified by join in the same query — never
// trust a parent id from the URL alone. Shared by Api and Functions so background code
// carries the same isolation discipline.
//
// These take the DbContext, not a DbSet: the owned DbSets are internal to Domain, so from
// Api/Functions this class is the only compiling route to owned data.
public static class ScopedQueryExtensions
{
    // -- Trainer scope: trainer_id = session user --

    /// <summary>The trainer's client roster (the trainer's own row has trainer_id NULL and is excluded).</summary>
    public static IQueryable<User> ClientsForTrainer(this TrainerOsDbContext db, Guid trainerId)
        => db.Users.Where(u => u.TrainerId == trainerId);

    public static IQueryable<Exercise> ExercisesForTrainer(this TrainerOsDbContext db, Guid trainerId)
        => db.Exercises.Where(e => e.TrainerId == trainerId);

    public static IQueryable<Program> ProgramsForTrainer(this TrainerOsDbContext db, Guid trainerId)
        => db.Programs.Where(p => p.TrainerId == trainerId);

    public static IQueryable<ProgramDay> ProgramDaysForTrainer(this TrainerOsDbContext db, Guid trainerId)
        => db.ProgramDays.Where(d => d.Program.TrainerId == trainerId);

    public static IQueryable<ProgramDayExercise> ProgramDayExercisesForTrainer(this TrainerOsDbContext db, Guid trainerId)
        => db.ProgramDayExercises.Where(e => e.ProgramDay.Program.TrainerId == trainerId);

    public static IQueryable<WorkoutSession> WorkoutSessionsForTrainer(this TrainerOsDbContext db, Guid trainerId)
        => db.WorkoutSessions.Where(s => s.TrainerId == trainerId);

    public static IQueryable<LoggedSet> LoggedSetsForTrainer(this TrainerOsDbContext db, Guid trainerId)
        => db.LoggedSets.Where(s => s.Session.TrainerId == trainerId);

    public static IQueryable<NotificationSchedule> NotificationSchedulesForTrainer(this TrainerOsDbContext db, Guid trainerId)
        => db.NotificationSchedules.Where(s => s.TrainerId == trainerId);

    public static IQueryable<NotificationDelivery> NotificationDeliveriesForTrainer(this TrainerOsDbContext db, Guid trainerId)
        => db.NotificationDeliveries.Where(d => d.Schedule.TrainerId == trainerId);

    // -- Client scope: client_id = session user --

    public static IQueryable<Program> ProgramsForClient(this TrainerOsDbContext db, Guid clientId)
        => db.Programs.Where(p => p.ClientId == clientId);

    public static IQueryable<ProgramDay> ProgramDaysForClient(this TrainerOsDbContext db, Guid clientId)
        => db.ProgramDays.Where(d => d.Program.ClientId == clientId);

    public static IQueryable<ProgramDayExercise> ProgramDayExercisesForClient(this TrainerOsDbContext db, Guid clientId)
        => db.ProgramDayExercises.Where(e => e.ProgramDay.Program.ClientId == clientId);

    public static IQueryable<WorkoutSession> WorkoutSessionsForClient(this TrainerOsDbContext db, Guid clientId)
        => db.WorkoutSessions.Where(s => s.ClientId == clientId);

    public static IQueryable<LoggedSet> LoggedSetsForClient(this TrainerOsDbContext db, Guid clientId)
        => db.LoggedSets.Where(s => s.Session.ClientId == clientId);

    public static IQueryable<NotificationSchedule> NotificationSchedulesForClient(this TrainerOsDbContext db, Guid clientId)
        => db.NotificationSchedules.Where(s => s.ClientId == clientId);
}
