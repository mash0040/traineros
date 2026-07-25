namespace TrainerOS.Domain.Entities;

// The four status values of notification_deliveries.status (database.md §notification_deliveries).
// There is deliberately no 'sending': claiming a row before the provider accepts it would make
// the system at-most-once and lose reminders on a worker crash (notifications.md §Worker).
public static class DeliveryStatuses
{
    public const string Pending = "pending";
    public const string Sent = "sent";
    public const string Failed = "failed";
    public const string Dead = "dead";
}
