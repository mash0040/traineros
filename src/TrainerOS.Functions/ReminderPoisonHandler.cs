using Azure.Storage.Queues.Models;

using Microsoft.Azure.Functions.Worker;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;
using TrainerOS.Domain.Notifications;

namespace TrainerOS.Functions;

// notifications.md §Retry & dead-lettering: after maxDequeueCount failures the platform moves
// the message to reminders-poison by itself. This function is the last rites — it marks the
// row dead so the audit log says what happened, and logs at error severity, which is the one
// alert v1 has.
//
// Deliberately lightweight: no retry, no recovery, no re-enqueue. A delivery that has failed
// five times with backoff between attempts has been failing for over an hour, and by then a
// reminder is worthless anyway (the worker's own expiry rule says the same thing).
public sealed class ReminderPoisonHandler(TrainerOsDbContext db, ILogger<ReminderPoisonHandler> logger)
{
    private const string PoisonedReason = "dead-lettered: retries exhausted";

    [Function(nameof(ReminderPoisonHandler))]
    public async Task Run(
        [QueueTrigger(StorageReminderQueue.PoisonQueueName)] QueueMessage message,
        CancellationToken cancellationToken)
    {
        var parsed = ReminderMessage.TryParse(message.Body.ToString());
        if (parsed is null)
        {
            // Unreadable body: there is no row to mark, and throwing would only re-poison an
            // already-poisoned message. Log loudly and ack — this is the end of the line.
            logger.LogError(
                "Poisoned reminder message {MessageId} could not be read; no delivery row to mark dead",
                message.MessageId);
            return;
        }

        await MarkDeadAsync(parsed.DeliveryId, cancellationToken);
    }

    public async Task MarkDeadAsync(Guid deliveryId, CancellationToken cancellationToken = default)
    {
        var delivery = await db.DeliveryToSend(deliveryId)
            .Select(d => d.Delivery)
            .FirstOrDefaultAsync(cancellationToken);

        if (delivery is null)
        {
            logger.LogError(
                "Poisoned reminder names delivery {DeliveryId}, which no longer exists", deliveryId);
            return;
        }

        // A 'sent' row is not dead. The poison message can outlive a send that succeeded on a
        // redelivery, and overwriting the successful outcome would make the audit log lie.
        if (delivery.Status is not (DeliveryStatuses.Pending or DeliveryStatuses.Failed))
        {
            logger.LogError(
                "Poisoned reminder for delivery {DeliveryId} left as {Status}; not overwriting a terminal outcome",
                deliveryId, delivery.Status);
            return;
        }

        delivery.Status = DeliveryStatuses.Dead;
        // last_error keeps the provider's own words when there are any — "why did this die"
        // is answered better by "421 mailbox unavailable" than by our summary of it.
        delivery.LastError ??= PoisonedReason;
        await db.SaveChangesAsync(cancellationToken);

        // The row's own counter, not the poison message's DequeueCount: a poisoned message is
        // on its first delivery to *this* queue, so that number is always 1 and reads as a
        // lie next to "retries exhausted". notification_deliveries.attempts is where the real
        // count lives — confirmed the hard way by a live run that logged "after 1 attempts".
        logger.LogError(
            "Reminder delivery {DeliveryId} (schedule {ScheduleId}) dead-lettered after {Attempts} attempts: {LastError}",
            delivery.Id, delivery.ScheduleId, delivery.Attempts, delivery.LastError);
    }
}
