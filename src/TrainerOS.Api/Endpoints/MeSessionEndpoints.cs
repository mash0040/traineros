using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

namespace TrainerOS.Api.Endpoints;

// api.md §Client endpoints — the client's own logging surface. Ownership of the
// route-param :id in /sessions/:id/sets is verified by join to client_id = session
// user (api.md §Authorization pt 3): the parent id from the URL is a filter, never
// a lookup. A cross-client session id collapses to the same 404 as a fabricated id.
//
// Not idempotent by design (api.md §Cross-cutting): duplicate POSTs create duplicate
// sets, which the client can delete same-day; client-side disable-on-submit mitigates.
public static class MeSessionEndpoints
{
    public sealed record CreateSessionRequest(
        DateOnly? PerformedOn,
        Guid? ProgramDayId,
        string? Comment);

    public sealed record SessionResponse(
        Guid Id,
        DateOnly PerformedOn,
        Guid? ProgramDayId,
        string? Comment,
        DateTimeOffset CreatedAt);

    public sealed record LogSetRequest(
        Guid? ExerciseId,
        Guid? ProgramDayExerciseId,
        int? SetNumber,
        decimal? WeightKg,
        int? Reps);

    public sealed record LoggedSetResponse(
        Guid Id,
        Guid SessionId,
        Guid ExerciseId,
        Guid? ProgramDayExerciseId,
        int SetNumber,
        decimal? WeightKg,
        int Reps,
        DateTimeOffset LoggedAt);

    public sealed record UpdateSetRequest(int? SetNumber, decimal? WeightKg, int? Reps);

    public sealed record UpdateSessionRequest(string? Comment);

    public static RouteGroupBuilder MapMeSessionEndpoints(this RouteGroupBuilder api)
    {
        var meSessions = api.MapGroup("/me/sessions").RequireClient();
        meSessions.MapPost("", CreateSession)
            .Produces<SessionResponse>(StatusCodes.Status201Created);
        meSessions.MapPost("/{id:guid}/sets", LogSet)
            .Produces<LoggedSetResponse>(StatusCodes.Status201Created);
        meSessions.MapPatch("/{id:guid}", UpdateSession)
            .Produces<SessionResponse>();

        var meSets = api.MapGroup("/me/sets").RequireClient();
        meSets.MapPatch("/{id:guid}", UpdateSet)
            .Produces<LoggedSetResponse>();
        return api;
    }

    private static async Task<IResult> CreateSession(
        CreateSessionRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var client = http.GetCurrentUser()!;

        if (client.TrainerId is not { } trainerId)
        {
            // A client with no trainer_id is a schema violation — refuse rather than
            // seed an orphaned session.
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        if (body.PerformedOn is not { } performedOn)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "performed_on is required."));
        }

        // program_day_id nullable = freestyle session. When set, it's a body-field
        // identity → 400 unknown_program_day for cross-client and truly-unknown alike
        // (api.md #27 clarification).
        if (body.ProgramDayId is { } programDayId)
        {
            var owned = await db.ProgramDaysForClient(client.Id)
                .AnyAsync(d => d.Id == programDayId, cancellationToken);
            if (!owned)
            {
                return Results.BadRequest(ApiError.Create("unknown_program_day", "Unknown program_day_id."));
            }
        }

        var session = new WorkoutSession
        {
            Id = Guid.NewGuid(),
            TrainerId = trainerId,
            ClientId = client.Id,
            ProgramDayId = body.ProgramDayId,
            PerformedOn = performedOn,
            Comment = NullIfBlank(body.Comment),
            CreatedAt = clock.GetUtcNow(),
        };
        db.Add(session);
        await db.SaveChangesAsync(cancellationToken);

        return Results.Created($"/api/me/sessions/{session.Id}",
            new SessionResponse(session.Id, session.PerformedOn, session.ProgramDayId,
                session.Comment, session.CreatedAt));
    }

    private static async Task<IResult> LogSet(
        Guid id,
        LogSetRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var client = http.GetCurrentUser()!;

        if (client.TrainerId is not { } trainerId)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        if (body.ExerciseId is not { } exerciseId)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "exercise_id is required."));
        }

        if (body.SetNumber is not { } setNumber || setNumber <= 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "set_number must be a positive integer."));
        }

        if (body.Reps is not { } reps || reps <= 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "reps must be a positive integer."));
        }

        if (body.WeightKg is { } w && w < 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "weight_kg cannot be negative."));
        }

        // Ownership of the route-param :id verified by join through WorkoutSessionsForClient —
        // a session id belonging to another client is indistinguishable from a made-up
        // id (the AC's isolation test).
        var sessionExists = await db.WorkoutSessionsForClient(client.Id)
            .AnyAsync(s => s.Id == id, cancellationToken);
        if (!sessionExists)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        // Body-field: exercise must be in the client's trainer's library. Soft-deleted
        // (is_active=false) exercises are still valid for LOGGING — the trainer may
        // retire a library entry mid-cycle, and the client must still be able to log
        // today's session against it. Contrast prescription creation, which rejects
        // inactive exercises (fresh authoring shouldn't resurrect retired).
        var exerciseKnown = await db.ExercisesForTrainer(trainerId)
            .AnyAsync(e => e.Id == exerciseId, cancellationToken);
        if (!exerciseKnown)
        {
            return Results.BadRequest(ApiError.Create("unknown_exercise", "Unknown exercise_id."));
        }

        // Body-field: prescription (optional). If given, must belong to the client's
        // own programs. The dual-reference design allows exercise_id + null
        // program_day_exercise_id (freestyle/substitution) — that's not an error.
        if (body.ProgramDayExerciseId is { } pdxId)
        {
            var pdxOwned = await db.ProgramDayExercisesForClient(client.Id)
                .AnyAsync(e => e.Id == pdxId, cancellationToken);
            if (!pdxOwned)
            {
                return Results.BadRequest(
                    ApiError.Create("unknown_program_day_exercise", "Unknown program_day_exercise_id."));
            }
        }

        var loggedSet = new LoggedSet
        {
            Id = Guid.NewGuid(),
            SessionId = id,
            ExerciseId = exerciseId,
            ProgramDayExerciseId = body.ProgramDayExerciseId,
            SetNumber = setNumber,
            WeightKg = body.WeightKg,
            Reps = reps,
            LoggedAt = clock.GetUtcNow(),
        };
        db.Add(loggedSet);
        await db.SaveChangesAsync(cancellationToken);

        return Results.Created($"/api/me/sets/{loggedSet.Id}",
            new LoggedSetResponse(loggedSet.Id, loggedSet.SessionId, loggedSet.ExerciseId,
                loggedSet.ProgramDayExerciseId, loggedSet.SetNumber, loggedSet.WeightKg,
                loggedSet.Reps, loggedSet.LoggedAt));
    }

    // PATCH /api/me/sessions/:id — the client's note to their trainer, after the fact.
    //
    // Exists because the comment is authored during a workout while the row is created at its
    // start (the first logged set), so POST is no longer the moment the note is finished. The
    // log workout screen holds the draft on the device until there is somewhere to put it.
    //
    // Comment only. performed_on and program_day_id are what the session *is*; changing either
    // would move a workout to another day or another prescription, which is not an edit — it
    // is a different session, and history that reshapes itself is the thing database.md's
    // principle 4 protects against.
    //
    // Same-day window per #32, measured against created_at rather than performed_on. That is
    // the same choice #32 made for sets and for the same stated reason: the window governs the
    // entry event, so a workout logged retroactively stays editable through the day it was
    // entered. Editing a note days later is history revision, not a typo fix.
    private static async Task<IResult> UpdateSession(
        Guid id,
        UpdateSessionRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var client = http.GetCurrentUser()!;

        // Ownership by join, never by the route param alone: WorkoutSessionsForClient scopes
        // to client_id = session user, so another client's session id is a 404 that reads
        // exactly like a fabricated one.
        var session = await db.WorkoutSessionsForClient(client.Id)
            .FirstOrDefaultAsync(s => s.Id == id, cancellationToken);
        if (session is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        var tz = TimeZoneInfo.FindSystemTimeZoneById(client.Timezone);
        var createdLocal = TimeZoneInfo.ConvertTime(session.CreatedAt, tz);
        var todayLocal = TimeZoneInfo.ConvertTime(clock.GetUtcNow(), tz);
        if (DateOnly.FromDateTime(createdLocal.DateTime) != DateOnly.FromDateTime(todayLocal.DateTime))
        {
            // 404, not 403 — the same no-existence-oracle convention the set patch uses for
            // its window. A stale session and a session that was never theirs are one answer.
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        // Divergence from PATCH /me/sets/:id, where a null field means "don't touch": with one
        // field in the body, "don't touch" would make the whole request a no-op and leave no
        // way to take a note back. So the body is the new value, and null or blank clears it —
        // matching what POST already does with the same input.
        session.Comment = NullIfBlank(body.Comment);
        await db.SaveChangesAsync(cancellationToken);

        return Results.Ok(new SessionResponse(session.Id, session.PerformedOn, session.ProgramDayId,
            session.Comment, session.CreatedAt));
    }

    // api.md: "PATCH /api/me/sets/:id — fix a typo'd set. same-day only … 403-shaped
    // 404 after that." Nested ownership: LoggedSetsForClient joins through
    // workout_sessions.client_id — a cross-client set id is a 404, indistinguishable
    // from a fabricated id. The same-day window is computed in the client's timezone
    // (users.timezone), so a set logged at 23:30 America/Toronto stays editable for
    // 30 minutes, not 4½ hours as a UTC-day rule would give.
    private static async Task<IResult> UpdateSet(
        Guid id,
        UpdateSetRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var client = http.GetCurrentUser()!;

        if (body.SetNumber is { } sn && sn <= 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "set_number must be a positive integer."));
        }

        if (body.Reps is { } r && r <= 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "reps must be a positive integer."));
        }

        if (body.WeightKg is { } w && w < 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "weight_kg cannot be negative."));
        }

        var set = await db.LoggedSetsForClient(client.Id)
            .FirstOrDefaultAsync(s => s.Id == id, cancellationToken);
        if (set is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        // Same-day window in the client's local time. Missing the window is a 404
        // (not 403, not 400) — the api.md convention treats "not currently yours to
        // touch" the same shape as "doesn't exist" so timing behavior can't be probed.
        var tz = TimeZoneInfo.FindSystemTimeZoneById(client.Timezone);
        var loggedLocal = TimeZoneInfo.ConvertTime(set.LoggedAt, tz);
        var todayLocal = TimeZoneInfo.ConvertTime(clock.GetUtcNow(), tz);
        if (DateOnly.FromDateTime(loggedLocal.DateTime) != DateOnly.FromDateTime(todayLocal.DateTime))
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        if (body.SetNumber is not null)
        {
            set.SetNumber = body.SetNumber.Value;
        }

        // WeightKg: null on the wire = don't touch. Clearing a value back to bodyweight
        // via PATCH isn't supported in v1 — the trainer/client workflow is delete +
        // re-add for that rare case, which sidesteps the "null means not sent" gap.
        if (body.WeightKg is not null)
        {
            set.WeightKg = body.WeightKg;
        }

        if (body.Reps is not null)
        {
            set.Reps = body.Reps.Value;
        }

        await db.SaveChangesAsync(cancellationToken);

        return Results.Ok(new LoggedSetResponse(
            set.Id, set.SessionId, set.ExerciseId, set.ProgramDayExerciseId,
            set.SetNumber, set.WeightKg, set.Reps, set.LoggedAt));
    }

    private static string? NullIfBlank(string? value)
    {
        if (value is null) return null;
        var trimmed = value.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }
}
