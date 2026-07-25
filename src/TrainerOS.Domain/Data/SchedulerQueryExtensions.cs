using Microsoft.EntityFrameworkCore;

using TrainerOS.Domain.Entities;

namespace TrainerOS.Domain.Data;

// The background scope, the third and last one after ScopedQueryExtensions (a session's
// tenant) and AuthQueryExtensions (a credential). The reminder scheduler runs on nobody's
// behalf: it sweeps every trainer's schedules on a timer, so "ownership in the WHERE
// clause" has no session id to key on. That makes it the one place where an unscoped read
// is correct — and the reason it lives here, narrow and named, instead of the owned DbSets
// becoming public: from Functions this file is still the only compiling route to the data,
// and its whole surface is auditable on one screen.
//
// Nothing here takes a user id, and nothing here should ever be called from a request path.
public static class SchedulerQueryExtensions
{
    /// <summary>
    /// Every enabled schedule paired with its recipient's <em>current</em> timezone —
    /// resolved per run, so a client who moves cities is correct on the next tick with no
    /// schedule migration (notifications.md §Scheduler).
    /// </summary>
    // users.is_active is deliberately not filtered: the send-time guard belongs to the
    // worker (notifications.md §Worker step 2), which is the only place late enough to be
    // right about a client deactivated after scheduling.
    public static IQueryable<ScheduledReminder> EnabledSchedulesWithRecipient(this TrainerOsDbContext db)
        => from s in db.NotificationSchedules
           where s.Enabled
           join u in db.Users on s.ClientId equals u.Id
           select new ScheduledReminder(s, u.Timezone);

    /// <summary>
    /// Inserts a delivery, returning false when the occurrence already had one. This is the
    /// idempotency mechanism from notifications.md §Scheduler: duplicate scheduler runs
    /// collapse into no-op inserts on the idempotency_key unique index rather than being
    /// avoided by scheduler bookkeeping, so a replayed or crashed-mid-run tick is harmless.
    /// The boolean is what makes "enqueue only rows actually inserted" possible.
    /// </summary>
    // Raw SQL because ON CONFLICT DO NOTHING has no EF Core expression: SaveChanges would
    // throw a DbUpdateException on the duplicate and roll back the whole batch, turning the
    // designed no-op into an error path. The statement is portable between Postgres and the
    // SQLite used by tests, and every value is a parameter.
    public static async Task<bool> TryInsertDeliveryAsync(
        this TrainerOsDbContext db, NotificationDelivery delivery, CancellationToken cancellationToken = default)
    {
        var rows = await db.Database.ExecuteSqlInterpolatedAsync(
            $"""
             INSERT INTO notification_deliveries
                 (id, schedule_id, user_id, channel, scheduled_for, idempotency_key, status, attempts)
             VALUES
                 ({delivery.Id}, {delivery.ScheduleId}, {delivery.UserId}, {delivery.Channel},
                  {delivery.ScheduledFor}, {delivery.IdempotencyKey}, {delivery.Status}, {delivery.Attempts})
             ON CONFLICT (idempotency_key) DO NOTHING
             """,
            cancellationToken);

        return rows == 1;
    }

    /// <summary>
    /// Rows still 'pending' — the raw material of the sweep that recovers an enqueue which
    /// failed after its insert committed, or a message the queue simply lost
    /// (notifications.md §Failure modes, pending-sweep). How stale is stale enough is the
    /// caller's call, on the caller's clock: DateTimeOffset comparisons don't translate on
    /// every provider (SQLite in tests), exactly as UserBySession returns expiry as data.
    /// </summary>
    // Only 'pending': a 'failed' row is mid-retry and owned by the queue's visibility
    // timeout, so re-enqueueing it here would race the platform's own redelivery. The rows
    // this hands back beyond the sweep's cutoff are only those scheduled inside the last
    // sweep age — at most one client's worth each — so the unfiltered tail is bounded by
    // the roster, not by history.
    public static IQueryable<NotificationDelivery> PendingDeliveries(this TrainerOsDbContext db)
        => db.NotificationDeliveries.Where(d => d.Status == DeliveryStatuses.Pending);
}

public sealed record ScheduledReminder(NotificationSchedule Schedule, string Timezone);
