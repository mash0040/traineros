using System.Text.Json.Serialization;

namespace TrainerOS.Domain.Notifications;

// notifications.md §Queue: the message is a pointer, not a payload — the delivery row is
// the state, so nothing can drift between queue and database and no email content goes
// stale in a queued message. This is the whole wire contract between the scheduler (#37)
// and the worker (#38).
public sealed record ReminderMessage([property: JsonPropertyName("delivery_id")] Guid DeliveryId);

// The transport seam, alongside INotificationSender: the scheduler depends on "a queue",
// Azure Queue Storage is one implementation, and tests get to assert what was enqueued
// without an emulator.
public interface IReminderQueue
{
    Task EnqueueAsync(Guid deliveryId, CancellationToken cancellationToken = default);
}
