using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;

namespace TrainerOS.Api.Endpoints;

// api.md §Client endpoints — the client's read-only past-workout surface. Both
// endpoints scope through LoggedSetsForClient (join through workout_sessions.client_id),
// so a cross-client exercise_id or session_id passed as a query param never yields
// another client's rows; it silently produces empty results (the isolation invariant
// is preserved by the query shape, not by explicit rejection).
//
// The `logged_sets (exercise_id, logged_at)` index (database.md §Indexing) is the
// physical basis for both queries — the compound key lets the exercise_id filter and
// the logged_at DESC ordering both be index-served.
public static class MeHistoryEndpoints
{
    private const int DefaultLimit = 20;
    private const int MaxLimit = 100;

    public sealed record HistoryItem(
        Guid Id,
        int SetNumber,
        decimal? WeightKg,
        int Reps,
        DateTimeOffset LoggedAt,
        HistorySessionSummary Session,
        HistoryExerciseRef Exercise);

    public sealed record HistorySessionSummary(Guid Id, DateOnly PerformedOn, string? Comment);

    public sealed record HistoryExerciseRef(Guid Id, string Name);

    // Cursor-paginated: nextCursor is the loggedAt of the last item when the page
    // was full, null on the final page. Callers re-issue with ?before=<nextCursor>
    // — no offsets, no total count (both are misleading at scale).
    public sealed record HistoryResponse(List<HistoryItem> Items, DateTimeOffset? NextCursor);

    public sealed record LastSet(
        Guid Id,
        int SetNumber,
        decimal? WeightKg,
        int Reps,
        DateTimeOffset LoggedAt);

    public sealed record LastMostRecent(
        Guid SessionId,
        DateOnly PerformedOn,
        HistoryExerciseRef Exercise,
        List<LastSet> Sets);

    // Wrapper mirrors GET /api/me/program's { program: null } — "no history yet"
    // and "here's your last session" share one JSON shape, so the SPA renders
    // the empty state without branching on HTTP status.
    public sealed record LastResponse(LastMostRecent? MostRecent);

    public static RouteGroupBuilder MapMeHistoryEndpoints(this RouteGroupBuilder api)
    {
        var me = api.MapGroup("/me").RequireClient();
        me.MapGet("/history", GetHistory);
        me.MapGet("/last", GetLast);
        return api;
    }

    private static async Task<IResult> GetHistory(
        [FromQuery(Name = "exercise_id")] Guid? exerciseId,
        [FromQuery(Name = "before")] DateTimeOffset? before,
        [FromQuery(Name = "limit")] int? limit,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var client = http.GetCurrentUser()!;

        var pageSize = limit ?? DefaultLimit;
        if (pageSize <= 0 || pageSize > MaxLimit)
        {
            return Results.BadRequest(ApiError.Create(
                "bad_request", $"limit must be between 1 and {MaxLimit}."));
        }

        // Base query is client-scoped. A cross-client exercise_id filters to zero
        // rows without leaking existence — the scoped extension is doing the work.
        var query = db.LoggedSetsForClient(client.Id);
        if (exerciseId is { } exId)
        {
            query = query.Where(s => s.ExerciseId == exId);
        }
        if (before is { } cursor)
        {
            query = query.Where(s => s.LoggedAt < cursor);
        }

        var rows = await query
            .OrderByDescending(s => s.LoggedAt)
            .Take(pageSize)
            .Select(s => new
            {
                s.Id,
                s.SetNumber,
                s.WeightKg,
                s.Reps,
                s.LoggedAt,
                SessionId = s.Session.Id,
                SessionPerformedOn = s.Session.PerformedOn,
                SessionComment = s.Session.Comment,
                s.ExerciseId,
            })
            .AsNoTracking()
            .ToListAsync(cancellationToken);

        // Second query: batch-fetch exercise names for the page. Two round-trips,
        // not N+1 (contrast: including exercise per-row would still be one JOIN,
        // but this pattern lets the exercise index take a page's-worth of keys
        // in a single WHERE id IN (…)).
        var exerciseIds = rows.Select(r => r.ExerciseId).Distinct().ToList();
        var exerciseNames = exerciseIds.Count == 0 || client.TrainerId is not { } trainerId
            ? new Dictionary<Guid, string>()
            : await db.ExercisesForTrainer(trainerId)
                .Where(e => exerciseIds.Contains(e.Id))
                .Select(e => new { e.Id, e.Name })
                .AsNoTracking()
                .ToDictionaryAsync(e => e.Id, e => e.Name, cancellationToken);

        var items = rows.Select(r => new HistoryItem(
            r.Id, r.SetNumber, r.WeightKg, r.Reps, r.LoggedAt,
            new HistorySessionSummary(r.SessionId, r.SessionPerformedOn, r.SessionComment),
            new HistoryExerciseRef(r.ExerciseId, exerciseNames.GetValueOrDefault(r.ExerciseId, ""))
        )).ToList();

        var nextCursor = items.Count == pageSize
            ? items[^1].LoggedAt
            : (DateTimeOffset?)null;

        return Results.Ok(new HistoryResponse(items, nextCursor));
    }

    private static async Task<IResult> GetLast(
        [FromQuery(Name = "exercise_id")] Guid? exerciseId,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var client = http.GetCurrentUser()!;

        if (exerciseId is not { } exId)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "exercise_id is required."));
        }

        // Design decision: "most recent sets for an exercise" = the sets from the
        // single most-recent SESSION containing this exercise, not an arbitrary
        // N most-recent sets. Rationale: the gym-floor mental model is "last time
        // I benched" — a coherent session block, not a scatter of set rows across
        // sessions. This preserves session context (all top-set + backoffs stay
        // grouped) and keeps the exercise_id + logged_at index one lookup.
        var mostRecentSetOfExercise = await db.LoggedSetsForClient(client.Id)
            .Where(s => s.ExerciseId == exId)
            .OrderByDescending(s => s.LoggedAt)
            .Select(s => new { s.SessionId, s.Session.PerformedOn })
            .AsNoTracking()
            .FirstOrDefaultAsync(cancellationToken);

        if (mostRecentSetOfExercise is null)
        {
            return Results.Ok(new LastResponse(null));
        }

        var sets = await db.LoggedSetsForClient(client.Id)
            .Where(s => s.SessionId == mostRecentSetOfExercise.SessionId && s.ExerciseId == exId)
            .OrderBy(s => s.SetNumber)
            .Select(s => new LastSet(s.Id, s.SetNumber, s.WeightKg, s.Reps, s.LoggedAt))
            .AsNoTracking()
            .ToListAsync(cancellationToken);

        var exerciseName = client.TrainerId is not { } trainerId
            ? string.Empty
            : await db.ExercisesForTrainer(trainerId)
                .Where(e => e.Id == exId)
                .Select(e => e.Name)
                .AsNoTracking()
                .FirstOrDefaultAsync(cancellationToken) ?? string.Empty;

        var response = new LastResponse(new LastMostRecent(
            mostRecentSetOfExercise.SessionId,
            mostRecentSetOfExercise.PerformedOn,
            new HistoryExerciseRef(exId, exerciseName),
            sets));
        return Results.Ok(response);
    }
}
