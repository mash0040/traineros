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

    public static RouteGroupBuilder MapProgramEndpoints(this RouteGroupBuilder api)
    {
        var programs = api.MapGroup("/programs").RequireTrainer();
        programs.MapGet("", ListPrograms);
        programs.MapPost("", CreateProgram);
        programs.MapGet("/{id:guid}", GetProgram);
        programs.MapPatch("/{id:guid}", UpdateProgram);
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

    private static async Task<IResult> GetProgram(
        Guid id, HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var program = await db.ProgramsForTrainer(trainer.Id)
            .Where(p => p.Id == id)
            .Select(p => new ProgramResponse(
                p.Id, p.ClientId, p.Title, p.Status, p.StartsOn, p.Notes, p.CreatedAt, p.UpdatedAt))
            .AsNoTracking()
            .FirstOrDefaultAsync(cancellationToken);

        return program is null
            ? Results.NotFound(ApiError.Create("not_found", "Not Found"))
            : Results.Ok(program);
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
