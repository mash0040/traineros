using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

namespace TrainerOS.Api.Endpoints;

// api.md §Trainer endpoints: the exercise library. Delete = PATCH is_active=false —
// hard-delete would orphan logged_sets, whose exercise_id is RESTRICT (database.md
// resolved question 1). Soft-deleted rows stay reachable through ExercisesForTrainer
// so the trainer can reactivate; the library UI is responsible for filtering.
public static class ExerciseEndpoints
{
    public sealed record CreateExerciseRequest(string? Name, string? VideoUrl, string? Cues);
    public sealed record UpdateExerciseRequest(string? Name, string? VideoUrl, string? Cues, bool? IsActive);

    public sealed record ExerciseResponse(
        Guid Id,
        string Name,
        string? VideoUrl,
        string? Cues,
        bool IsActive,
        DateTimeOffset CreatedAt);

    public static RouteGroupBuilder MapExerciseEndpoints(this RouteGroupBuilder api)
    {
        var exercises = api.MapGroup("/exercises").RequireTrainer();
        exercises.MapGet("", ListExercises);
        exercises.MapPost("", CreateExercise);
        exercises.MapPatch("/{id:guid}", UpdateExercise);
        return api;
    }

    private static async Task<IResult> ListExercises(
        HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var rows = await db.ExercisesForTrainer(trainer.Id)
            .OrderBy(e => e.Name)
            .Select(e => new ExerciseResponse(e.Id, e.Name, e.VideoUrl, e.Cues, e.IsActive, e.CreatedAt))
            .AsNoTracking()
            .ToListAsync(cancellationToken);

        return Results.Ok(rows);
    }

    private static async Task<IResult> CreateExercise(
        CreateExerciseRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var name = body.Name?.Trim();
        if (string.IsNullOrEmpty(name))
        {
            return Results.BadRequest(ApiError.Create("bad_request", "name is required."));
        }

        var exercise = new Exercise
        {
            Id = Guid.NewGuid(),
            TrainerId = trainer.Id,
            Name = name,
            VideoUrl = NullIfBlank(body.VideoUrl),
            Cues = NullIfBlank(body.Cues),
            IsActive = true,
            CreatedAt = clock.GetUtcNow(),
        };
        db.Add(exercise);
        await db.SaveChangesAsync(cancellationToken);

        var response = ToResponse(exercise);
        return Results.Created($"/api/exercises/{exercise.Id}", response);
    }

    private static async Task<IResult> UpdateExercise(
        Guid id,
        UpdateExerciseRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        string? newName = null;
        if (body.Name is not null)
        {
            newName = body.Name.Trim();
            if (string.IsNullOrEmpty(newName))
            {
                return Results.BadRequest(ApiError.Create("bad_request", "name cannot be blank."));
            }
        }

        var exercise = await db.ExercisesForTrainer(trainer.Id)
            .FirstOrDefaultAsync(e => e.Id == id, cancellationToken);
        if (exercise is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        if (newName is not null)
        {
            exercise.Name = newName;
        }

        // Optional-nullable field convention: absent/null = leave alone; empty string = clear
        // to NULL. There is no way to distinguish "not sent" from "explicit null" in a record
        // binding, so blank-as-clear is the only escape hatch for wiping a video_url or cues.
        if (body.VideoUrl is not null)
        {
            exercise.VideoUrl = NullIfBlank(body.VideoUrl);
        }

        if (body.Cues is not null)
        {
            exercise.Cues = NullIfBlank(body.Cues);
        }

        if (body.IsActive is not null)
        {
            exercise.IsActive = body.IsActive.Value;
        }

        await db.SaveChangesAsync(cancellationToken);

        return Results.Ok(ToResponse(exercise));
    }

    private static ExerciseResponse ToResponse(Exercise exercise) => new(
        exercise.Id, exercise.Name, exercise.VideoUrl, exercise.Cues, exercise.IsActive, exercise.CreatedAt);

    private static string? NullIfBlank(string? value)
    {
        if (value is null) return null;
        var trimmed = value.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }
}
