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
    public sealed record UpdateExerciseRequest(
        Patch<string> Name, Patch<string> VideoUrl, Patch<string> Cues, Patch<bool> IsActive);

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
        exercises.MapGet("", ListExercises)
            .Produces<List<ExerciseResponse>>();
        exercises.MapPost("", CreateExercise)
            .Produces<ExerciseResponse>(StatusCodes.Status201Created);
        exercises.MapPatch("/{id:guid}", UpdateExercise)
            .Produces<ExerciseResponse>();
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
            VideoUrl = body.VideoUrl?.Trim(),
            Cues = body.Cues?.Trim(),
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

        // #145: name backs a NOT NULL column, so an explicit null is a request to do something
        // impossible and is refused rather than silently ignored.
        string? newName = null;
        if (body.Name.IsNull)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "name cannot be null."));
        }
        if (body.Name.HasValue(out var sentName))
        {
            newName = sentName.Trim();
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

        // #145: absent leaves alone, null clears. #26's blank-string-clears sentinel is retired
        // — it only ever worked for strings, which is why weight_kg, rest_seconds and starts_on
        // had no clear path at all, and keeping it would make "" and null two spellings of one
        // thing on five fields and nowhere else. "" is now an ordinary value.
        if (body.VideoUrl.IsPresent)
        {
            exercise.VideoUrl = body.VideoUrl.Value;
        }

        if (body.Cues.IsPresent)
        {
            exercise.Cues = body.Cues.Value;
        }

        if (body.IsActive.IsNull)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "is_active cannot be null."));
        }
        if (body.IsActive.HasValue(out var isActive))
        {
            exercise.IsActive = isActive;
        }

        await db.SaveChangesAsync(cancellationToken);

        return Results.Ok(ToResponse(exercise));
    }

    private static ExerciseResponse ToResponse(Exercise exercise) => new(
        exercise.Id, exercise.Name, exercise.VideoUrl, exercise.Cues, exercise.IsActive, exercise.CreatedAt);

}
