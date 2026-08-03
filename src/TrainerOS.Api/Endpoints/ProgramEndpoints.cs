using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

// The Api project's namespaces collide with the entity type name at usage sites;
// aliasing keeps the endpoint code unambiguous without leaking the alias everywhere.
using ProgramEntity = TrainerOS.Domain.Entities.Program;

namespace TrainerOS.Api.Endpoints;

// api.md §Trainer endpoints: programs are client-owned (no templates, no versioning —
// database.md §programs). At-most-one-active-per-client is enforced by a partial unique
// index (status = 'active'); this handler treats DbUpdateException as the source of
// truth for that constraint, not an app-side count (AC #27). Days and prescriptions
// are managed by their own endpoints under a separate ticket.
public static class ProgramEndpoints
{
    public sealed record CreateProgramRequest(
        Guid? ClientId,
        string? Title,
        string? Status,
        DateOnly? StartsOn,
        string? Notes);

    public sealed record UpdateProgramRequest(
        string? Title,
        string? Status,
        DateOnly? StartsOn,
        string? Notes);

    public sealed record ProgramResponse(
        Guid Id,
        Guid ClientId,
        string Title,
        string Status,
        DateOnly? StartsOn,
        string? Notes,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt);

    /// <summary>
    /// GET /api/programs/:id — the program with its days and their prescriptions (#78).
    /// </summary>
    // A separate record rather than a Days list bolted onto ProgramResponse. The list,
    // create, and patch responses would then all have to answer with something for a field
    // they do not populate, and an empty array that means "not loaded" is indistinguishable
    // from one that means "this program has no days" — the builder would render a program as
    // empty on the strength of a response that never claimed otherwise.
    //
    // Everything below the program node is DayView from ProgramTreeViews.cs, the same tree
    // GET /api/me/program returns.
    public sealed record ProgramDetailResponse(
        Guid Id,
        Guid ClientId,
        string Title,
        string Status,
        DateOnly? StartsOn,
        string? Notes,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt,
        List<DayView> Days);

    public static RouteGroupBuilder MapProgramEndpoints(this RouteGroupBuilder api)
    {
        var programs = api.MapGroup("/programs").RequireTrainer();
        programs.MapGet("", ListPrograms)
            .Produces<List<ProgramResponse>>();
        programs.MapPost("", CreateProgram)
            .Produces<ProgramResponse>(StatusCodes.Status201Created)
            .Produces<ApiError>(StatusCodes.Status409Conflict);
        programs.MapGet("/{id:guid}", GetProgram)
            .Produces<ProgramDetailResponse>();
        programs.MapPatch("/{id:guid}", UpdateProgram)
            .Produces<ProgramResponse>();
        return api;
    }

    private static async Task<IResult> ListPrograms(
        HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var rows = await db.ProgramsForTrainer(trainer.Id)
            .OrderBy(p => p.Title)
            .Select(p => new ProgramResponse(
                p.Id, p.ClientId, p.Title, p.Status, p.StartsOn, p.Notes, p.CreatedAt, p.UpdatedAt))
            .AsNoTracking()
            .ToListAsync(cancellationToken);

        return Results.Ok(rows);
    }

    private static async Task<IResult> CreateProgram(
        CreateProgramRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        if (body.ClientId is not { } clientId)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "client_id is required."));
        }

        var title = body.Title?.Trim();
        if (string.IsNullOrEmpty(title))
        {
            return Results.BadRequest(ApiError.Create("bad_request", "title is required."));
        }

        var status = body.Status ?? ProgramStatuses.Draft;
        if (!ProgramStatuses.IsValid(status))
        {
            return Results.BadRequest(ApiError.Create(
                "bad_request", $"'{status}' is not a valid status."));
        }

        // Ownership check via the trainer's client roster: a client id belonging to another
        // trainer (or fabricated) collapses to the same 400 — no cross-tenant existence oracle.
        var clientOwned = await db.ClientsForTrainer(trainer.Id)
            .AnyAsync(u => u.Id == clientId, cancellationToken);
        if (!clientOwned)
        {
            return Results.BadRequest(ApiError.Create("unknown_client", "Unknown client_id."));
        }

        var now = clock.GetUtcNow();
        var program = new ProgramEntity
        {
            Id = Guid.NewGuid(),
            TrainerId = trainer.Id,
            ClientId = clientId,
            Title = title,
            Status = status,
            StartsOn = body.StartsOn,
            Notes = NullIfBlank(body.Notes),
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Add(program);

        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException)
        {
            // AC #27: 409 is backed by the partial unique index (status = 'active'),
            // not by an app-side count. The catch is the enforcement — no pre-check race
            // window can bypass it.
            return ActiveConflict();
        }

        return Results.Created($"/api/programs/{program.Id}", ToResponse(program));
    }

    // #78: the read the program builder (epic #8) is built on. Days ordered by position, each
    // with its prescriptions ordered by position, each prescription carrying the exercise it
    // names — one request, because a builder that has to fan out per day to learn what is in it
    // is a builder that renders in stages.
    //
    // Structured exactly like GET /api/me/program (#30), down to the two queries: a nested
    // projection for the tree, then one batched fetch for the exercises it references. The
    // alternative — resolving the exercise per prescription — is the N+1 that read was written
    // to avoid, and this one has more rows to be wrong about, since the trainer sees a whole
    // program rather than the client's active one.
    private static async Task<IResult> GetProgram(
        Guid id, HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        // Scoped through ProgramsForTrainer, so another trainer's program id finds nothing and
        // falls through to the same 404 a fabricated id gets. Ownership is in the WHERE clause;
        // there is no load-then-check to forget.
        var program = await db.ProgramsForTrainer(trainer.Id)
            .Where(p => p.Id == id)
            .Select(p => new
            {
                p.Id,
                p.ClientId,
                p.Title,
                p.Status,
                p.StartsOn,
                p.Notes,
                p.CreatedAt,
                p.UpdatedAt,
                Days = p.Days
                    .OrderBy(d => d.Position)
                    .Select(d => new
                    {
                        d.Id,
                        d.Title,
                        d.Position,
                        Prescriptions = d.Exercises
                            .OrderBy(pdx => pdx.Position)
                            .Select(pdx => new
                            {
                                pdx.Id,
                                pdx.Position,
                                pdx.TargetSets,
                                pdx.TargetReps,
                                pdx.TargetLoad,
                                pdx.RestSeconds,
                                pdx.Note,
                                pdx.ExerciseId,
                            })
                            .ToList(),
                    })
                    .ToList(),
            })
            .AsNoTracking()
            .FirstOrDefaultAsync(cancellationToken);

        if (program is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        var exerciseIds = program.Days
            .SelectMany(d => d.Prescriptions)
            .Select(p => p.ExerciseId)
            .Distinct()
            .ToList();

        // Scoped by the session trainer, which is the program's trainer by construction —
        // ProgramsForTrainer already put trainer_id in the WHERE clause above. (#30 reads this
        // off the program row instead, because there the scope is the *client* and the
        // program's trainer is not the caller.)
        //
        // is_active is deliberately not filtered. ExercisesForTrainer does not filter it
        // either, and a prescription written against an exercise the trainer has since
        // soft-deleted still has to render — showing the name is how they find the thing to
        // replace. The writes side keeps this dictionary total: POST/PATCH of a prescription
        // both validate exercise_id through ExercisesForTrainer, so a prescription can only
        // ever name an exercise in this same library.
        var exercises = exerciseIds.Count == 0
            ? new Dictionary<Guid, ExerciseView>()
            : await db.ExercisesForTrainer(trainer.Id)
                .Where(e => exerciseIds.Contains(e.Id))
                .Select(e => new ExerciseView(e.Id, e.Name, e.VideoUrl, e.Cues))
                .AsNoTracking()
                .ToDictionaryAsync(e => e.Id, cancellationToken);

        var response = new ProgramDetailResponse(
            program.Id, program.ClientId, program.Title, program.Status,
            program.StartsOn, program.Notes, program.CreatedAt, program.UpdatedAt,
            program.Days.Select(d => new DayView(
                d.Id, d.Title, d.Position,
                d.Prescriptions.Select(pdx => new PrescriptionView(
                    pdx.Id, pdx.Position, pdx.TargetSets, pdx.TargetReps,
                    pdx.TargetLoad, pdx.RestSeconds, pdx.Note,
                    exercises[pdx.ExerciseId]
                )).ToList()
            )).ToList());

        return Results.Ok(response);
    }

    private static async Task<IResult> UpdateProgram(
        Guid id,
        UpdateProgramRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        string? newTitle = null;
        if (body.Title is not null)
        {
            newTitle = body.Title.Trim();
            if (string.IsNullOrEmpty(newTitle))
            {
                return Results.BadRequest(ApiError.Create("bad_request", "title cannot be blank."));
            }
        }

        if (body.Status is not null && !ProgramStatuses.IsValid(body.Status))
        {
            return Results.BadRequest(ApiError.Create(
                "bad_request", $"'{body.Status}' is not a valid status."));
        }

        var program = await db.ProgramsForTrainer(trainer.Id)
            .FirstOrDefaultAsync(p => p.Id == id, cancellationToken);
        if (program is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        if (newTitle is not null)
        {
            program.Title = newTitle;
        }

        if (body.Status is not null)
        {
            program.Status = body.Status;
        }

        // StartsOn on the wire: null = leave alone (no clear path in v1; AC is silent
        // and a "clear the date" flow isn't in scope).
        if (body.StartsOn is not null)
        {
            program.StartsOn = body.StartsOn;
        }

        // Notes: blank-string-as-null, mirroring the exercises PATCH convention so the
        // trainer has an escape hatch for wiping the field.
        if (body.Notes is not null)
        {
            program.Notes = NullIfBlank(body.Notes);
        }

        program.UpdatedAt = clock.GetUtcNow();

        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException)
        {
            return ActiveConflict();
        }

        return Results.Ok(ToResponse(program));
    }

    private static ProgramResponse ToResponse(ProgramEntity program) => new(
        program.Id, program.ClientId, program.Title, program.Status,
        program.StartsOn, program.Notes, program.CreatedAt, program.UpdatedAt);

    private static IResult ActiveConflict() => Results.Json(
        ApiError.Create("program_active_conflict", "This client already has an active program."),
        statusCode: StatusCodes.Status409Conflict);

    private static string? NullIfBlank(string? value)
    {
        if (value is null) return null;
        var trimmed = value.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }
}
