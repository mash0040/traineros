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
        Patch<Guid> ExerciseId,
        Patch<int> TargetSets,
        Patch<string> TargetReps,
        Patch<string> TargetLoad,
        Patch<int> RestSeconds,
        Patch<string> Note);

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

        // Structural only — see PrescriptionText for exactly where the line is drawn. Both
        // fields stay free text and neither is parsed or converted; this refuses what cannot be
        // a phrase, not what it cannot understand.
        var textProblem = PrescriptionText.Check(targetReps, PrescriptionText.Field.Reps)
            ?? PrescriptionText.Check(body.TargetLoad, PrescriptionText.Field.Load);
        if (textProblem is not null)
        {
            return Results.BadRequest(ApiError.Create("bad_request", textProblem));
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
            TargetLoad = body.TargetLoad?.Trim(),
            RestSeconds = body.RestSeconds,
            Note = body.Note?.Trim(),
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

        // #145: exercise_id, target_sets and target_reps back NOT NULL columns. target_load,
        // rest_seconds and note are nullable and clear on an explicit null — rest_seconds being
        // the one this screen was already trying to clear and silently failing to.
        if (PatchRequests.RejectNull(body.ExerciseId, "exercise_id") is { } exerciseIdNull)
        {
            return exerciseIdNull;
        }

        if (PatchRequests.RejectNull(body.TargetSets, "target_sets") is { } targetSetsNull)
        {
            return targetSetsNull;
        }

        if (PatchRequests.RejectNull(body.TargetReps, "target_reps") is { } targetRepsNull)
        {
            return targetRepsNull;
        }

        if (body.TargetSets.HasValue(out var ts) && ts <= 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "target_sets must be a positive integer."));
        }

        string? newTargetReps = null;
        if (body.TargetReps.HasValue(out var sentReps))
        {
            newTargetReps = sentReps.Trim();
            if (string.IsNullOrEmpty(newTargetReps))
            {
                return Results.BadRequest(ApiError.Create("bad_request", "target_reps cannot be blank."));
            }
        }

        // Only what the body actually carries: an absent field is not re-checked, and a null
        // target_load is a clear rather than a value, so there is nothing in it to refuse.
        var textProblem = PrescriptionText.Check(newTargetReps, PrescriptionText.Field.Reps)
            ?? PrescriptionText.Check(body.TargetLoad.Value, PrescriptionText.Field.Load);
        if (textProblem is not null)
        {
            return Results.BadRequest(ApiError.Create("bad_request", textProblem));
        }

        if (body.RestSeconds.HasValue(out var rs) && rs <= 0)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "rest_seconds must be a positive integer."));
        }

        var prescription = await db.ProgramDayExercisesForTrainer(trainer.Id)
            .FirstOrDefaultAsync(e => e.Id == id, cancellationToken);
        if (prescription is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        if (body.ExerciseId.HasValue(out var newExerciseId))
        {
            var exerciseUsable = await db.ExercisesForTrainer(trainer.Id)
                .AnyAsync(e => e.Id == newExerciseId && e.IsActive, cancellationToken);
            if (!exerciseUsable)
            {
                return Results.BadRequest(ApiError.Create("unknown_exercise", "Unknown exercise_id."));
            }
            prescription.ExerciseId = newExerciseId;
        }

        if (body.TargetSets.HasValue(out var targetSets))
        {
            prescription.TargetSets = targetSets;
        }

        if (newTargetReps is not null)
        {
            prescription.TargetReps = newTargetReps;
        }

        // #145, all three nullable: absent leaves alone, null clears. Trim stays on the two
        // text fields because trimming is normalization; what went is #26's blank-string-as-null
        // sentinel, which only ever worked on strings.
        if (body.TargetLoad.IsPresent)
        {
            prescription.TargetLoad = body.TargetLoad.Value?.Trim();
        }

        // The unreported half of #145. This screen sends rest_seconds: null when the trainer
        // empties the field, and the old "null = leave alone" reading meant the previous value
        // came straight back with no error and nothing to explain it. Worse than the bodyweight
        // case that prompted the issue: there the SPA at least knew to refuse the edit.
        if (body.RestSeconds.IsPresent)
        {
            prescription.RestSeconds = body.RestSeconds.Nullable();
        }

        if (body.Note.IsPresent)
        {
            prescription.Note = body.Note.Value?.Trim();
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

}
