using TrainerOS.Domain.Entities;

namespace TrainerOS.Domain.Data;

// The pause link's scope. Like AuthQueryExtensions, this is keyed by a credential rather
// than by a tenant: the caller has no session, and a validated HMAC token names exactly one
// schedule (notifications.md resolved question 2). Possession of the emailed link is the
// authorization, so the only safe input to this query is a schedule id that
// PauseTokenSigner.Validate has already vouched for — never one off the wire.
public static class PauseQueryExtensions
{
    public static IQueryable<NotificationSchedule> ScheduleForPause(this TrainerOsDbContext db, Guid scheduleId)
        => db.NotificationSchedules.Where(s => s.Id == scheduleId);
}
