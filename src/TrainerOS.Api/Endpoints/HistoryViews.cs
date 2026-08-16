namespace TrainerOS.Api.Endpoints;

// A page of logged sets, shared by the two endpoints that return one: GET /api/me/history (#33,
// the client's own past workouts) and GET /api/clients/:id/history (#142, their trainer's view
// of the same rows).
//
// One representation, not two — the same argument ProgramTreeViews.cs makes for the program
// tree, and for the same reason. These are literally the same logged_sets rows read through two
// scopes, and the SPA consumes both through generated types with these exact names. A parallel
// set of records would be two things to keep in step, and lib/history.ts — which turns this
// flat feed into sessions and solves the page-boundary problem while doing it — would have to
// be written twice or made generic over two shapes that are identical anyway.
//
// They live in their own file rather than inside MeHistoryEndpoints because neither endpoint
// owns them now: a trainer endpoint reaching for MeHistoryEndpoints.HistoryItem would read as a
// dependency on the client's contract, which is exactly backwards.
//
// ── Flat sets, not sessions with nested sets ───────────────────────────────────────────────
// #33 chose the flat shape and #142 kept it rather than nesting for the trainer. Nesting would
// have been a third representation of these rows, and the grouping the screens actually render
// already exists on the client side in lib/history.ts, including the case that makes it hard:
// pagination counts sets while the screen renders sessions, so a page can end mid-workout and a
// session must be withheld until it is complete rather than rendered with a wrong set count.
//
// ── Weights are canonical kilograms, on both routes ────────────────────────────────────────
// WeightKg is what the column holds (database.md §users), and neither endpoint converts. Which
// unit a reader sees is decided at the display boundary from users.weight_unit — the *client's*,
// on both screens, because there is no trainer-side preference and database.md §users records
// why: the number a trainer is looking at is the number their client lifted and will lift again.
// Null is bodyweight and stays null in every unit.

/// <summary>One logged set, with enough context to render it without a second lookup.</summary>
public sealed record HistoryItem(
    Guid Id,
    int SetNumber,
    decimal? WeightKg,
    int Reps,
    DateTimeOffset LoggedAt,
    HistorySessionSummary Session,
    HistoryExerciseRef Exercise);

// ProgramDayId (#102) lets a caller identify which session belongs to which program day without
// a write. The log screen needs it on mount: POST /api/me/sessions is the only other route that
// resolves (client, performed_on, program_day_id), and asking it costs a row. Null for a
// freestyle session, which by design has no day to match on.
public sealed record HistorySessionSummary(
    Guid Id, DateOnly PerformedOn, string? Comment, Guid? ProgramDayId);

public sealed record HistoryExerciseRef(Guid Id, string Name);

/// <summary>
/// Cursor-paginated: nextCursor is the loggedAt of the last item when the page was full, null on
/// the final page. Callers re-issue with ?before=&lt;nextCursor&gt; — no offsets, no total count
/// (both are misleading at scale).
/// </summary>
public sealed record HistoryResponse(List<HistoryItem> Items, DateTimeOffset? NextCursor);
