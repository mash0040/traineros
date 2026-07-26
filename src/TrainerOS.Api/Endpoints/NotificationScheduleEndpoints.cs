using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

namespace TrainerOS.Api.Endpoints;

// api.md §Trainer endpoints: one reminder schedule per client (v1). The DB does not
// enforce this constraint today (no unique index on notification_schedules.client_id),
// so POST pre-checks and returns 409. Race window at one-trainer scale is effectively
// zero; if the schema gains a unique index later, the same 409 catch pattern applies.
//
// Deactivated-client policy: schedule POST and PATCH remain allowed even when the
// client is is_active=false. The worker re-checks users.is_active at send time
// (notifications.md skip rule), and ClientEndpoints deactivation already flips
// enabled=false on existing schedules — so trainer edits here can only express intent
// (e.g. keep a preferred send_time ready for reactivation), never leak email.
public static class NotificationScheduleEndpoints
{
    public sealed record CreateScheduleRequest(TimeOnly? SendTime, int[]? DaysOfWeek, bool? Enabled);
    public sealed record UpdateScheduleRequest(TimeOnly? SendTime, int[]? DaysOfWeek, bool? Enabled);

    public sealed record ScheduleResponse(
        Guid Id, Guid ClientId, string Kind, TimeOnly SendTime, int[] DaysOfWeek, bool Enabled);

    // v1 has exactly one notification kind (notifications.md resolved question 1
    // defers trainer_digest to v1.1). The value lives on the entity; the trainer
    // body does not accept a "kind" field because there is nothing else to send.
    private const string WorkoutReminderKind = "workout_reminder";

    public static RouteGroupBuilder MapNotificationScheduleEndpoints(this RouteGroupBuilder api)
    {
        var clients = api.MapGroup("/clients").RequireTrainer();
        clients.MapGet("/{id:guid}/schedule", GetSchedule)
            .Produces<ScheduleResponse>();
        clients.MapPost("/{id:guid}/schedule", CreateSchedule)
            .Produces<ScheduleResponse>(StatusCodes.Status201Created)
            .Produces<ApiError>(StatusCodes.Status409Conflict);

        var schedules = api.MapGroup("/schedules").RequireTrainer();
        schedules.MapPatch("/{id:guid}", UpdateSchedule)
            .Produces<ScheduleResponse>();
        return api;
    }

    private static async Task<IResult> GetSchedule(
        Guid id, HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        // No separate client-exists check: the scoped query returns nothing for both
        // "cross-tenant client id" and "your client, no schedule yet." Both collapse to
        // the same 404 — the trainer's client roster (GET /api/clients) is where they
        // learn ownership, and there's no cross-tenant existence oracle here.
        var schedule = await db.NotificationSchedulesForTrainer(trainer.Id)
            .Where(s => s.ClientId == id)
            .Select(s => new ScheduleResponse(
                s.Id, s.ClientId, s.Kind, s.SendTime, s.DaysOfWeek, s.Enabled))
            .AsNoTracking()
            .FirstOrDefaultAsync(cancellationToken);

        return schedule is null
            ? Results.NotFound(ApiError.Create("not_found", "Not Found"))
            : Results.Ok(schedule);
    }

    private static async Task<IResult> CreateSchedule(
        Guid id,
        CreateScheduleRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        if (body.SendTime is not { } sendTime)
        {
            return Results.BadRequest(ApiError.Create("bad_request", "send_time is required."));
        }

        if (ValidateDaysOfWeek(body.DaysOfWeek) is { } daysError)
        {
            return Results.BadRequest(daysError);
        }

        // Route-param identity check on the client id — 404 for cross-tenant and
        // unknown alike (api.md #27 clarification).
        var clientOwned = await db.ClientsForTrainer(trainer.Id)
            .AnyAsync(u => u.Id == id, cancellationToken);
        if (!clientOwned)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        // One-schedule-per-client is app-enforced (no DB unique index in v1). The
        // pre-check-then-insert has a race window; at one-trainer scale that's effectively
        // zero, and a duplicate schedule would surface as a harmless second row rather
        // than corruption. Documented gap.
        var existing = await db.NotificationSchedulesForTrainer(trainer.Id)
            .AnyAsync(s => s.ClientId == id, cancellationToken);
        if (existing)
        {
            return Results.Json(
                ApiError.Create("schedule_exists", "This client already has a schedule."),
                statusCode: StatusCodes.Status409Conflict);
        }

        var schedule = new NotificationSchedule
        {
            Id = Guid.NewGuid(),
            TrainerId = trainer.Id,
            ClientId = id,
            Kind = WorkoutReminderKind,
            SendTime = sendTime,
            DaysOfWeek = NormalizeDays(body.DaysOfWeek!),
            Enabled = body.Enabled ?? true,
        };
        db.Add(schedule);
        await db.SaveChangesAsync(cancellationToken);

        return Results.Created($"/api/schedules/{schedule.Id}", ToResponse(schedule));
    }

    private static async Task<IResult> UpdateSchedule(
        Guid id,
        UpdateScheduleRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        if (body.DaysOfWeek is not null && ValidateDaysOfWeek(body.DaysOfWeek) is { } daysError)
        {
            return Results.BadRequest(daysError);
        }

        var schedule = await db.NotificationSchedulesForTrainer(trainer.Id)
            .FirstOrDefaultAsync(s => s.Id == id, cancellationToken);
        if (schedule is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        if (body.SendTime is not null)
        {
            schedule.SendTime = body.SendTime.Value;
        }

        if (body.DaysOfWeek is not null)
        {
            schedule.DaysOfWeek = NormalizeDays(body.DaysOfWeek);
        }

        if (body.Enabled is not null)
        {
            schedule.Enabled = body.Enabled.Value;
        }

        await db.SaveChangesAsync(cancellationToken);

        return Results.Ok(ToResponse(schedule));
    }

    private static ApiError? ValidateDaysOfWeek(int[]? days)
    {
        if (days is null || days.Length == 0)
        {
            return ApiError.Create("bad_request", "days_of_week must be non-empty.");
        }

        if (days.Any(d => d < 0 || d > 6))
        {
            return ApiError.Create("bad_request", "days_of_week values must be 0..6 (Sun..Sat).");
        }

        if (days.Distinct().Count() != days.Length)
        {
            return ApiError.Create("bad_request", "days_of_week must not contain duplicates.");
        }

        return null;
    }

    // Sort + dedup for canonical storage — trainer can send {5,1,3} and GET returns
    // {1,3,5}. Scheduler queries also benefit from a predictable ordering.
    private static int[] NormalizeDays(int[] days) => days.Distinct().OrderBy(d => d).ToArray();

    private static ScheduleResponse ToResponse(NotificationSchedule s) => new(
        s.Id, s.ClientId, s.Kind, s.SendTime, s.DaysOfWeek, s.Enabled);
}
