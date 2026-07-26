using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

namespace TrainerOS.Api.Endpoints;

// api.md §Trainer endpoints: program-day management. Ownership is verified by join
// through program → trainer_id (ProgramDaysForTrainer), so a day id belonging to another
// trainer collapses to the same 404 as a fabricated id. Position handling for the day's
// prescriptions is the "full ordered id list, one transaction" pattern (rejected
// alternative in api.md: fractional/gap positions).
public static class ProgramDayEndpoints
{
    public sealed record CreateDayRequest(string? Title);
    public sealed record UpdateDayRequest(string? Title, int? Position);
    public sealed record ReorderExercisesRequest(List<Guid>? OrderedIds);

    public sealed record ProgramDayResponse(Guid Id, Guid ProgramId, string Title, int Position);

    public static RouteGroupBuilder MapProgramDayEndpoints(this RouteGroupBuilder api)
    {
        // Nested route under /programs/:id/days for create — the URL puts the day inside
        // its owning program, so the ownership chain is inspectable in the path.
        var programs = api.MapGroup("/programs").RequireTrainer();
        programs.MapPost("/{id:guid}/days", CreateDay)
            .Produces<ProgramDayResponse>(StatusCodes.Status201Created);

        var days = api.MapGroup("/days").RequireTrainer();
        days.MapPatch("/{id:guid}", UpdateDay)
            .Produces<ProgramDayResponse>();
        days.MapDelete("/{id:guid}", DeleteDay)
            .Produces(StatusCodes.Status204NoContent);
        days.MapPatch("/{id:guid}/order", ReorderDayExercises)
            .Produces(StatusCodes.Status204NoContent);
        return api;
    }

    private static async Task<IResult> CreateDay(
        Guid id,
        CreateDayRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var title = body.Title?.Trim();
        if (string.IsNullOrEmpty(title))
        {
            return Results.BadRequest(ApiError.Create("bad_request", "title is required."));
        }

        // Route-param identity check: an unknown or cross-tenant program id is a 404
        // (api.md #27 clarification — route params vs body fields distinguish 404 vs 400).
        var programOwned = await db.ProgramsForTrainer(trainer.Id)
            .AnyAsync(p => p.Id == id, cancellationToken);
        if (!programOwned)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        // Server-assigned position at the end. The AC's "full ordered id list on reorder"
        // pattern owns position mutation; individual writes just append.
        var currentMax = await db.ProgramDaysForTrainer(trainer.Id)
            .Where(d => d.ProgramId == id)
            .Select(d => (int?)d.Position)
            .MaxAsync(cancellationToken);
        var nextPosition = (currentMax ?? 0) + 1;

        var day = new ProgramDay
        {
            Id = Guid.NewGuid(),
            ProgramId = id,
            Title = title,
            Position = nextPosition,
        };
        db.Add(day);
        await db.SaveChangesAsync(cancellationToken);

        return Results.Created($"/api/days/{day.Id}", ToResponse(day));
    }

    private static async Task<IResult> UpdateDay(
        Guid id,
        UpdateDayRequest body,
        HttpContext http,
        TrainerOsDbContext db,
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

        var day = await db.ProgramDaysForTrainer(trainer.Id)
            .FirstOrDefaultAsync(d => d.Id == id, cancellationToken);
        if (day is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        if (newTitle is not null)
        {
            day.Title = newTitle;
        }

        if (body.Position is not null)
        {
            day.Position = body.Position.Value;
        }

        await db.SaveChangesAsync(cancellationToken);

        return Results.Ok(ToResponse(day));
    }

    private static async Task<IResult> DeleteDay(
        Guid id, HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var day = await db.ProgramDaysForTrainer(trainer.Id)
            .FirstOrDefaultAsync(d => d.Id == id, cancellationToken);
        if (day is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        // Prescriptions cascade (program_day_exercises ON DELETE CASCADE); logged
        // workout_sessions.program_day_id is ON DELETE SET NULL so history survives
        // (database.md principle 4). No manual bookkeeping required.
        db.Remove(day);
        await db.SaveChangesAsync(cancellationToken);

        return Results.NoContent();
    }

    private static async Task<IResult> ReorderDayExercises(
        Guid id,
        ReorderExercisesRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var orderedIds = body.OrderedIds;
        if (orderedIds is null)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "ordered_ids is required."));
        }

        if (orderedIds.Distinct().Count() != orderedIds.Count)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "ordered_ids contains duplicates."));
        }

        var day = await db.ProgramDaysForTrainer(trainer.Id)
            .Include(d => d.Exercises)
            .FirstOrDefaultAsync(d => d.Id == id, cancellationToken);
        if (day is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        var currentIds = day.Exercises.Select(e => e.Id).ToHashSet();
        var incomingSet = orderedIds.ToHashSet();
        if (!currentIds.SetEquals(incomingSet))
        {
            // Missing or extra ids: reject as a whole. The AC calls for the full ordered
            // list; partial reorders defeat the "no fractional positions" invariant.
            return Results.BadRequest(ApiError.Create(
                "bad_request", "ordered_ids must be exactly the day's prescriptions."));
        }

        // api.md §Trainer endpoints: "server rewrites positions in one transaction."
        // A single SaveChangesAsync is already atomic, but an explicit transaction
        // makes the intent visible and future-proofs against additional writes.
        await using var tx = await db.Database.BeginTransactionAsync(cancellationToken);

        for (var i = 0; i < orderedIds.Count; i++)
        {
            var prescription = day.Exercises.First(e => e.Id == orderedIds[i]);
            prescription.Position = i + 1;
        }
        await db.SaveChangesAsync(cancellationToken);
        await tx.CommitAsync(cancellationToken);

        return Results.NoContent();
    }

    private static ProgramDayResponse ToResponse(ProgramDay day) =>
        new(day.Id, day.ProgramId, day.Title, day.Position);
}
