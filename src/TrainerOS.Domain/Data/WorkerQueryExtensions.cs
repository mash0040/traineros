using TrainerOS.Domain.Entities;

namespace TrainerOS.Domain.Data;

// The worker's half of the background scope (see SchedulerQueryExtensions for the other).
// A queue message names a delivery id and nothing else, so the worker's entry point is an
// id lookup rather than a tenant query — but everything it reads *after* that goes through
// the ordinary scoped extensions (ProgramsForClient for the email's contents), because a
// worker that queries unscoped is the same IDOR with no URL to point at
// (architecture.md §Repo layout).
public static class WorkerQueryExtensions
{
    /// <summary>
    /// The delivery plus everything its send-time guards need, in one query: the recipient's
    /// address and active flag, and whether the schedule is still enabled
    /// (notifications.md §Worker step 2). Both flags are read now, not as the scheduler saw
    /// them 30 minutes ago — that lag is the entire reason the guard lives here.
    /// </summary>
    // The delivery entity comes back tracked (no AsNoTracking on the caller's side) so the
    // worker can mark the row's outcome without a second round trip.
    public static IQueryable<DeliveryToSend> DeliveryToSend(this TrainerOsDbContext db, Guid deliveryId)
        => from d in db.NotificationDeliveries
           where d.Id == deliveryId
           join s in db.NotificationSchedules on d.ScheduleId equals s.Id
           join u in db.Users on d.UserId equals u.Id
           select new DeliveryToSend(d, s.Enabled, u.Email, u.IsActive);
}

public sealed record DeliveryToSend(
    NotificationDelivery Delivery, bool ScheduleEnabled, string RecipientEmail, bool RecipientIsActive);
