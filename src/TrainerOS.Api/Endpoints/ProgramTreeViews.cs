namespace TrainerOS.Api.Endpoints;

// The program tree below the program node, shared by the two endpoints that return it:
// GET /api/me/program (#30, the client's active program) and GET /api/programs/:id (#78, the
// trainer's builder view).
//
// One representation, not two. The trainer and the client are looking at the same rows —
// program_days and program_day_exercises — and a parallel set of records describing them would
// be two things to keep in step, in a codebase where the SPA consumes both through generated
// types with these exact names. When the client's view of a prescription changes, the
// builder's has to change with it or the builder is editing a shape the client never sees.
//
// They live in their own file rather than inside either endpoint class because neither owns
// them any more: a trainer endpoint reaching for MeEndpoints.DayView would read as a
// dependency on the client's contract, which is exactly backwards.
//
// What is deliberately *not* shared is the program node itself. The client gets
// MeProgramDetails (title, status, dates, notes) and the trainer gets ProgramDetailResponse,
// which also carries client_id and the audit timestamps. Same tree, different roots, because
// the two callers genuinely need different facts about the program.

public sealed record DayView(Guid Id, string Title, int Position, List<PrescriptionView> Prescriptions);

public sealed record PrescriptionView(
    Guid Id,
    int Position,
    int TargetSets,
    string TargetReps,
    string? TargetLoad,
    int? RestSeconds,
    string? Note,
    ExerciseView Exercise);

public sealed record ExerciseView(Guid Id, string Name, string? VideoUrl, string? Cues);
