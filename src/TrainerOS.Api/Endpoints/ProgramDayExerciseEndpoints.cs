using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

namespace TrainerOS.Api.Endpoints;

// api.md §Trainer endpoints: prescription rows on program days. target_reps and
// target_load are text on purpose (database.md §program_day_exercises decision:
// '8–10', 'RPE 8', '5/3/1' are real prescriptions). Body-field identity checks on
// exercise_id return 400 unknown_exercise — cross-tenant and truly-unknown collapse
// to the same response per api.md #27's clarification.
public static class ProgramDayExerciseEndpoints
{
    public sealed record CreatePrescriptionRequest(
        Guid? ExerciseId,
        int? TargetSets,
        string? TargetReps,
        string? TargetLoad,
        int? RestSeconds,
        string? Note);

    public sealed record UpdatePrescriptionRequest(
        Guid? ExerciseId,
        int? TargetSets,
        string? TargetReps,
        string? TargetLoad,
        int? RestSeconds,
        string? Note);

    public sealed record PrescriptionResponse(
        Guid Id,
        Guid ProgramDayId,
        Guid ExerciseId,
        int Position,
        int TargetSets,
        string TargetReps,
        string? TargetLoad,
        int? RestSeconds,
        string? Note);

    public static RouteGroupBuilder MapProgramDayExerciseEndpoints(this RouteGroupBuilder api)
    {
        var days = api.MapGroup("/days").RequireTrainer();
        days.MapPost("/{id:guid}/exercises", CreatePrescription)
            .Produces<PrescriptionResponse>(StatusCodes.Status201Created);

        var dayExercises = api.MapGroup("/day-exercises").RequireTrainer();
        dayExercises.MapPatch("/{id:guid}", UpdatePrescription)
            .Produces<PrescriptionResponse>();
        dayExercises.MapDelete("/{id:guid}", DeletePrescription)
            .Produces(StatusCodes.Status204NoContent);
        return api;
    }

    private static async Task<IResult> CreatePrescription(
        Guid id,
        CreatePrescriptionRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        if (body.ExerciseId is not { } exerciseId)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "exercise_id is required."));
        }

        if (body.TargetSets is not { } targetSets || targetSets <= 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "target_sets must be a positive integer."));
        }

        var targetReps = body.TargetReps?.Trim();
        if (string.IsNullOrEmpty(targetReps))
        {
            return Results.BadRequest(ApiError.Create("bad_request", "target_reps is required."));
        }

        if (body.RestSeconds is { } rs && rs <= 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "rest_seconds must be a positive integer."));
        }

        // Route-param identity check on the day: 404 (api.md #27 clarification).
        var day = await db.ProgramDaysForTrainer(trainer.Id)
            .FirstOrDefaultAsync(d => d.Id == id, cancellationToken);
        if (day is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        // Body-field identity check on the exercise: 400 unknown_exercise. Soft-deleted
        // (is_active=false) exercises are treated as unknown here — retired-from-library
        // is the intent of soft-delete, so new prescriptions must not resurrect them.
        var exerciseUsable = await db.ExercisesForTrainer(trainer.Id)
            .AnyAsync(e => e.Id == exerciseId && e.IsActive, cancellationToken);
        if (!exerciseUsable)
        {
            return Results.BadRequest(ApiError.Create("unknown_exercise", "Unknown exercise_id."));
        }

        var currentMax = await db.ProgramDayExercisesForTrainer(trainer.Id)
            .Where(e => e.ProgramDayId == id)
            .Select(e => (int?)e.Position)
            .MaxAsync(cancellationToken);
        var nextPosition = (currentMax ?? 0) + 1;

        var prescription = new ProgramDayExercise
        {
            Id = Guid.NewGuid(),
            ProgramDayId = id,
            ExerciseId = exerciseId,
            Position = nextPosition,
            TargetSets = targetSets,
            TargetReps = targetReps,
            TargetLoad = NullIfBlank(body.TargetLoad),
            RestSeconds = body.RestSeconds,
            Note = NullIfBlank(body.Note),
        };
        db.Add(prescription);
        await db.SaveChangesAsync(cancellationToken);

        return Results.Created($"/api/day-exercises/{prescription.Id}", ToResponse(prescription));
    }

    private static async Task<IResult> UpdatePrescription(
        Guid id,
        UpdatePrescriptionRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        if (body.TargetSets is { } ts && ts <= 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "target_sets must be a positive integer."));
        }

        string? newTargetReps = null;
        if (body.TargetReps is not null)
        {
            newTargetReps = body.TargetReps.Trim();
            if (string.IsNullOrEmpty(newTargetReps))
            {
                return Results.BadRequest(ApiError.Create("bad_request", "target_reps cannot be blank."));
            }
        }

        if (body.RestSeconds is { } rs && rs <= 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "rest_seconds must be a positive integer."));
        }

        var prescription = await db.ProgramDayExercisesForTrainer(trainer.Id)
            .FirstOrDefaultAsync(e => e.Id == id, cancellationToken);
        if (prescription is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        if (body.ExerciseId is { } newExerciseId)
        {
            var exerciseUsable = await db.ExercisesForTrainer(trainer.Id)
                .AnyAsync(e => e.Id == newExerciseId && e.IsActive, cancellationToken);
            if (!exerciseUsable)
            {
                return Results.BadRequest(ApiError.Create("unknown_exercise", "Unknown exercise_id."));
            }
            prescription.ExerciseId = newExerciseId;
        }

        if (body.TargetSets is not null)
        {
            prescription.TargetSets = body.TargetSets.Value;
        }

        if (newTargetReps is not null)
        {
            prescription.TargetReps = newTargetReps;
        }

        // Nullable text fields: blank string = clear to NULL, null on wire = leave alone.
        // Same convention as exercises and programs.
        if (body.TargetLoad is not null)
        {
            prescription.TargetLoad = NullIfBlank(body.TargetLoad);
        }

        if (body.RestSeconds is not null)
        {
            prescription.RestSeconds = body.RestSeconds;
        }

        if (body.Note is not null)
        {
            prescription.Note = NullIfBlank(body.Note);
        }

        await db.SaveChangesAsync(cancellationToken);

        return Results.Ok(ToResponse(prescription));
    }

    private static async Task<IResult> DeletePrescription(
        Guid id, HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var prescription = await db.ProgramDayExercisesForTrainer(trainer.Id)
            .FirstOrDefaultAsync(e => e.Id == id, cancellationToken);
        if (prescription is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        // logged_sets.program_day_exercise_id is ON DELETE SET NULL — the historical set
        // survives, keyed by its always-set exercise_id (database.md principle 4).
        db.Remove(prescription);
        await db.SaveChangesAsync(cancellationToken);

        return Results.NoContent();
    }

    private static PrescriptionResponse ToResponse(ProgramDayExercise p) => new(
        p.Id, p.ProgramDayId, p.ExerciseId, p.Position, p.TargetSets,
        p.TargetReps, p.TargetLoad, p.RestSeconds, p.Note);

    private static string? NullIfBlank(string? value)
    {
        if (value is null) return null;
        var trimmed = value.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }
}
