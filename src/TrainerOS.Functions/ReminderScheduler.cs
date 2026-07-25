using System.Globalization;

using Microsoft.Azure.Functions.Worker;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;
using TrainerOS.Domain.Notifications;

namespace TrainerOS.Functions;

/// <summary>What one scheduler tick did — the shape of its summary log line, and what tests assert on.</summary>
public sealed record ReminderSchedulerSummary(
    int SchedulesConsidered,
    int OccurrencesDue,
    int Inserted,
    int AlreadyScheduled,
    int Enqueued,
    int Swept,
    int TimezoneFailures,
    int EnqueueFailures);

// notifications.md §Architecture: the timer-triggered half of the pipeline. Every 15 min it
// computes the occurrences due in the next 30 (#36's math), inserts a delivery row per
// occurrence with ON CONFLICT DO NOTHING, and enqueues a pointer for each row it actually
// inserted. Then it sweeps rows left 'pending' past their moment and re-enqueues them.
//
// The scheduler owns no correctness by itself: idempotency lives in the database's unique
// index, the send-time guard lives in the worker, and retry lives in the queue. What it
// must not do is lose an occurrence — which is why an enqueue failure never stops the
// insert pass (an insert missed while the window has moved on is gone forever, an enqueue
// missed is recovered by the sweep).
public sealed class ReminderScheduler(
    TrainerOsDbContext db,
    ReminderOccurrenceCalculator calculator,
    IReminderQueue queue,
    TimeProvider clock,
    ILogger<ReminderScheduler> logger)
{
    // notifications.md §Failure modes: 'pending' 20 min past its moment means "the enqueue
    // never landed" — the lookahead is only 30 min, so a row this stale was never going to
    // be picked up by an in-flight message.
    public static readonly TimeSpan PendingSweepAge = TimeSpan.FromMinutes(20);

    // database.md §notification_deliveries: v1 has one channel. The column exists so
    // WhatsApp/push are adapters later rather than a migration.
    private const string EmailChannel = "email";

    [Function(nameof(ReminderScheduler))]
    public async Task Run([TimerTrigger("0 */15 * * * *")] TimerInfo timer, CancellationToken cancellationToken)
        => await RunAsync(cancellationToken);

    public async Task<ReminderSchedulerSummary> RunAsync(CancellationToken cancellationToken = default)
    {
        var considered = 0;
        var due = 0;
        var inserted = 0;
        var alreadyScheduled = 0;
        var enqueued = 0;
        var timezoneFailures = 0;
        var enqueueFailures = 0;

        var schedules = await db.EnabledSchedulesWithRecipient()
            .AsNoTracking()
            .ToListAsync(cancellationToken);

        foreach (var (schedule, timezone) in schedules)
        {
            considered++;

            IReadOnlyList<ReminderOccurrence> occurrences;
            try
            {
                occurrences = calculator.DueOccurrences(schedule, timezone);
            }
            catch (TimeZoneNotFoundException)
            {
                // Skip this row, finish the run. A schedule pass is a batch over independent
                // clients: aborting would turn one client's unresolvable timezone id into a
                // silent outage of everyone's reminders. Timezone ids are validated on write,
                // so reaching here means the tz database renamed or dropped one — a data
                // problem that a human fixes on the client's profile, at which point the next
                // tick heals it (the run is idempotent, so nothing was consumed by failing).
                // Logged as a warning with the offending value: notification_deliveries is the
                // audit log, and a schedule that produces no row leaves no other trace.
                timezoneFailures++;
                logger.LogWarning(
                    "Reminder schedule skipped: unknown timezone {Timezone} for schedule {ScheduleId} (client {ClientId})",
                    timezone, schedule.Id, schedule.ClientId);
                continue;
            }

            foreach (var occurrence in occurrences)
            {
                due++;

                var delivery = new NotificationDelivery
                {
                    Id = Guid.NewGuid(),
                    ScheduleId = schedule.Id,
                    UserId = schedule.ClientId,
                    Channel = EmailChannel,
                    // Normalized to offset zero: the calculator reports occurrences at the
                    // recipient's local offset (07:00-04:00), and Npgsql rejects a non-zero
                    // offset for timestamptz. Same instant, storable shape.
                    ScheduledFor = occurrence.ScheduledFor.ToUniversalTime(),
                    // The local occurrence date, not the UTC date of the instant: a Friday
                    // 23:30 reminder in Toronto is a Saturday in UTC, and a DST shift can move
                    // the UTC date under a fixed local one. Keying on the local day is what
                    // makes "one reminder per scheduled day" true across both. Invariant
                    // culture because this is a key, not a display string — a non-Gregorian
                    // host calendar must not silently change what the key means.
                    IdempotencyKey =
                        $"{schedule.Id}:{occurrence.LocalDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}",
                    Status = DeliveryStatuses.Pending,
                    Attempts = 0,
                };

                if (!await db.TryInsertDeliveryAsync(delivery, cancellationToken))
                {
                    // Conflict: an earlier run already created and enqueued this occurrence.
                    // Enqueueing here would be a second message for one row — harmless to
                    // correctness (the worker guards on status) but a duplicate email in the
                    // window between send and status update. Cheap to avoid; don't.
                    alreadyScheduled++;
                    continue;
                }

                inserted++;

                if (await TryEnqueueAsync(delivery.Id, schedule.Id, cancellationToken))
                {
                    enqueued++;
                }
                else
                {
                    enqueueFailures++;
                }
            }
        }

        var swept = await SweepPendingAsync(cancellationToken);

        var summary = new ReminderSchedulerSummary(
            considered, due, inserted, alreadyScheduled, enqueued, swept, timezoneFailures, enqueueFailures);

        logger.LogInformation(
            "Reminder scheduler run: {Considered} schedules, {Due} occurrences due, {Inserted} inserted, "
            + "{AlreadyScheduled} already scheduled, {Enqueued} enqueued, {Swept} swept, "
            + "{TimezoneFailures} timezone failures, {EnqueueFailures} enqueue failures",
            considered, due, inserted, alreadyScheduled, enqueued, swept, timezoneFailures, enqueueFailures);

        return summary;
    }

    // The pending-sweep from notifications.md §Failure modes: the DB is the source of truth,
    // so 'pending' past its window means "re-enqueue me" — the recovery path for an enqueue
    // that failed after its insert committed, and for a message the queue lost outright.
    // Rows too stale to be worth sending are not filtered here: the worker owns the 6-hour
    // expiry check, and re-enqueueing is precisely what lets it mark them dead.
    private async Task<int> SweepPendingAsync(CancellationToken cancellationToken)
    {
        var cutoff = clock.GetUtcNow() - PendingSweepAge;

        var pending = await db.PendingDeliveries()
            .Select(d => new { d.Id, d.ScheduleId, d.ScheduledFor })
            .AsNoTracking()
            .ToListAsync(cancellationToken);

        var swept = 0;
        foreach (var delivery in pending.Where(d => d.ScheduledFor < cutoff))
        {
            if (await TryEnqueueAsync(delivery.Id, delivery.ScheduleId, cancellationToken))
            {
                swept++;
            }
        }

        return swept;
    }

    // An enqueue failure is a recoverable state by design — the row is committed 'pending'
    // and the sweep will come back for it — so it is logged and stepped over rather than
    // allowed to abort a run that still has other clients' occurrences to insert. Broad
    // catch on purpose: every transport failure has the same recovery, and the alternative
    // is enumerating one SDK's exception types here. Cancellation is not a queue failure.
    private async Task<bool> TryEnqueueAsync(Guid deliveryId, Guid scheduleId, CancellationToken cancellationToken)
    {
        try
        {
            await queue.EnqueueAsync(deliveryId, cancellationToken);
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(
                ex,
                "Enqueue failed for delivery {DeliveryId} (schedule {ScheduleId}); row stays pending for the sweep",
                deliveryId, scheduleId);
            return false;
        }
    }
}
