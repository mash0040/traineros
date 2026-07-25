using TrainerOS.Domain.Entities;

namespace TrainerOS.Domain.Notifications;

// One occurrence of a schedule: the local date it belongs to and the UTC instant it is
// due at. The date is half of `idempotency_key = {schedule_id}:{occurrence date}`
// (notifications.md §Scheduler) — an occurrence is identified by the local day the
// trainer scheduled, not by the UTC day it happens to land on.
public sealed record ReminderOccurrence(DateOnly LocalDate, DateTimeOffset ScheduledFor);

// notifications.md §Scheduler, the DST rule: `send_time` is local wall-clock time
// resolved against `users.timezone` at computation time. 07:00 stays 07:00 across a DST
// transition, `days_of_week` matches the local weekday rather than the UTC one, and a
// send_time inside the nonexistent hour of a spring-forward day resolves to the next
// valid instant.
//
// This type is that computation and nothing else: schedule + timezone + current instant
// (from TimeProvider — never DateTime.UtcNow) in, UTC instants due in the lookahead
// window out. Inserting notification_deliveries, enqueueing, and the pending sweep are
// the scheduler's job (#37). `Enabled` and `users.is_active` are deliberately not read
// here either: selecting enabled schedules is the scheduler's query, and the send-time
// guard on both flags belongs to the worker (notifications.md §Worker step 2).
public sealed class ReminderOccurrenceCalculator(TimeProvider clock)
{
    // notifications.md §Architecture: the timer fires every 15 min against a 30 min
    // lookahead. The overlap is intentional — duplicate occurrences collapse on the
    // idempotency_key unique index instead of being avoided here.
    public static readonly TimeSpan LookaheadWindow = TimeSpan.FromMinutes(30);

    // Occurrences due in [now, now + 30 min): the lower bound is inclusive so an
    // occurrence landing exactly on `now` is never dropped, the upper bound exclusive so
    // the boundary instant belongs to exactly one window.
    public IReadOnlyList<ReminderOccurrence> DueOccurrences(NotificationSchedule schedule, string timezone)
    {
        // Unknown ids throw: the write paths validate `users.timezone` against the tz
        // database (ClientEndpoints), so an unresolvable id here is broken data, and how
        // loudly one bad row fails a scheduler run is #37's call.
        var tz = TimeZoneInfo.FindSystemTimeZoneById(timezone);

        var from = clock.GetUtcNow();
        var until = from + LookaheadWindow;

        // Candidate local dates, from the local date of `from` through the local date of
        // `until` — a 30 min window can straddle local midnight. One extra day of slack
        // on the near side because resolving a wall clock only ever moves an instant
        // forward, which in zones that transition across midnight can carry the previous
        // local date's occurrence into this window; the window filter below discards
        // whatever that turns up.
        var firstDate = LocalDateOf(from, tz).AddDays(-1);
        var lastDate = LocalDateOf(until, tz);

        var occurrences = new List<ReminderOccurrence>();
        for (var date = firstDate; date <= lastDate; date = date.AddDays(1))
        {
            // Local weekday, matched against days_of_week's 0..6 Sun..Sat (api.md), which
            // is exactly DayOfWeek's numbering.
            if (!schedule.DaysOfWeek.Contains((int)date.DayOfWeek))
            {
                continue;
            }

            var scheduledFor = Resolve(date.ToDateTime(schedule.SendTime), tz);
            if ((scheduledFor >= from) && (scheduledFor < until))
            {
                occurrences.Add(new ReminderOccurrence(date, scheduledFor));
            }
        }

        return occurrences;
    }

    private static DateOnly LocalDateOf(DateTimeOffset instant, TimeZoneInfo tz)
        => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(instant, tz).DateTime);

    // Wall clock → instant. Both DST edges are decided here.
    private static DateTimeOffset Resolve(DateTime wallClock, TimeZoneInfo tz)
    {
        if (tz.IsInvalidTime(wallClock))
        {
            return FirstInstantAfterGap(wallClock, tz);
        }

        // Fall-back day: the wall clock happens twice. Take the earlier instant — the
        // larger UTC offset, i.e. still on daylight time — so the reminder arrives at the
        // first 01:30 rather than an hour late. Only one delivery row exists for the
        // occurrence date either way, so the earlier of the two is the one that counts.
        var offset = tz.IsAmbiguousTime(wallClock)
            ? tz.GetAmbiguousTimeOffsets(wallClock).Max()
            : tz.GetUtcOffset(wallClock);

        return new DateTimeOffset(wallClock, offset);
    }

    // A wall clock inside a spring-forward gap never happens; the next valid instant is
    // the one the clock jumps to — 02:30 on a 02:00→03:00 day is 03:00 local, not 03:30.
    // TimeZoneInfo exposes no portable transition instants, so bisect for it: local time
    // is non-decreasing in UTC, and the offsets a day either side of the gap bracket the
    // crossover where local time first reaches `wallClock` — which is the gap's end.
    // (Zones do not transition twice within a day, so a day of slack is enough.)
    private static DateTimeOffset FirstInstantAfterGap(DateTime wallClock, TimeZoneInfo tz)
    {
        var wallAsUtc = new DateTimeOffset(wallClock, TimeSpan.Zero);

        // local(lo) = wallClock - gap, so the predicate is false; local(hi) = wallClock +
        // gap, so it holds. Bisect on ticks to land on the transition exactly.
        var lo = (wallAsUtc - tz.GetUtcOffset(wallClock.AddDays(1))).UtcTicks;
        var hi = (wallAsUtc - tz.GetUtcOffset(wallClock.AddDays(-1))).UtcTicks;

        while ((hi - lo) > 1)
        {
            var mid = lo + ((hi - lo) / 2);
            if (TimeZoneInfo.ConvertTime(new DateTimeOffset(mid, TimeSpan.Zero), tz).DateTime >= wallClock)
            {
                hi = mid;
            }
            else
            {
                lo = mid;
            }
        }

        return new DateTimeOffset(hi, TimeSpan.Zero);
    }
}
