using TrainerOS.Domain.Entities;
using TrainerOS.Domain.Notifications;

namespace TrainerOS.Tests;

// notifications.md §Scheduler DST rule, pinned to real transitions: Toronto springs
// forward 2026-03-08 (02:00 EST → 03:00 EDT) and falls back 2026-11-01 (02:00 EDT →
// 01:00 EST); Sydney springs forward 2026-10-04 (02:00 AEST → 03:00 AEDT).
public class ReminderOccurrenceCalculatorTests
{
    private const string Toronto = "America/Toronto";

    private static DateTimeOffset Utc(int year, int month, int day, int hour, int minute)
        => new(year, month, day, hour, minute, 0, TimeSpan.Zero);

    private static ReminderOccurrenceCalculator CalculatorAt(DateTimeOffset now)
        => new(new FakeClock { Now = now });

    private static NotificationSchedule Schedule(TimeOnly sendTime, params int[] daysOfWeek) => new()
    {
        Id = Guid.NewGuid(),
        TrainerId = Guid.NewGuid(),
        ClientId = Guid.NewGuid(),
        Kind = "workout_reminder",
        SendTime = sendTime,
        DaysOfWeek = daysOfWeek,
        Enabled = true,
    };

    private static readonly int[] EveryDay = [0, 1, 2, 3, 4, 5, 6];

    [Fact]
    public void Occurrence_in_the_window_carries_its_utc_instant_and_local_date()
    {
        // 07:00 EST (UTC-5) on a plain winter day.
        var calculator = CalculatorAt(Utc(2026, 3, 1, 11, 45));

        var occurrence = Assert.Single(
            calculator.DueOccurrences(Schedule(new TimeOnly(7, 0), EveryDay), Toronto));

        Assert.Equal(Utc(2026, 3, 1, 12, 0), occurrence.ScheduledFor);
        Assert.Equal(new DateOnly(2026, 3, 1), occurrence.LocalDate);
    }

    [Fact]
    public void Wall_clock_send_time_survives_spring_forward()
    {
        var schedule = Schedule(new TimeOnly(7, 0), EveryDay);

        // Same 07:00 local, a week either side of the transition: EST is UTC-5, EDT UTC-4.
        var beforeTransition = CalculatorAt(Utc(2026, 3, 1, 12, 0)).DueOccurrences(schedule, Toronto);
        var afterTransition = CalculatorAt(Utc(2026, 3, 15, 11, 0)).DueOccurrences(schedule, Toronto);

        Assert.Equal(Utc(2026, 3, 1, 12, 0), Assert.Single(beforeTransition).ScheduledFor);
        Assert.Equal(Utc(2026, 3, 15, 11, 0), Assert.Single(afterTransition).ScheduledFor);
    }

    [Fact]
    public void Send_time_inside_the_spring_forward_gap_resolves_to_the_next_valid_instant()
    {
        // 02:30 does not exist on 2026-03-08; the clock jumps 02:00 EST → 03:00 EDT,
        // which is 07:00Z. Not 07:30Z — the next valid instant, not the wall clock
        // shifted by the gap.
        var calculator = CalculatorAt(Utc(2026, 3, 8, 6, 45));

        var occurrence = Assert.Single(
            calculator.DueOccurrences(Schedule(new TimeOnly(2, 30), 0), Toronto));

        Assert.Equal(Utc(2026, 3, 8, 7, 0), occurrence.ScheduledFor);
        Assert.Equal(new DateOnly(2026, 3, 8), occurrence.LocalDate);
    }

    [Fact]
    public void Ambiguous_send_time_on_the_fall_back_day_takes_the_earlier_instant()
    {
        // 01:30 happens twice on 2026-11-01: 05:30Z (EDT) then 06:30Z (EST).
        var schedule = Schedule(new TimeOnly(1, 30), 0);

        var firstPass = CalculatorAt(Utc(2026, 11, 1, 5, 20)).DueOccurrences(schedule, Toronto);
        var secondPass = CalculatorAt(Utc(2026, 11, 1, 6, 20)).DueOccurrences(schedule, Toronto);

        Assert.Equal(Utc(2026, 11, 1, 5, 30), Assert.Single(firstPass).ScheduledFor);
        Assert.Empty(secondPass);
    }

    [Fact]
    public void Days_of_week_match_the_local_weekday_not_the_utc_one()
    {
        // 23:30 Friday in Toronto is already Saturday in UTC.
        var now = Utc(2026, 1, 3, 4, 20);
        var sendTime = new TimeOnly(23, 30);

        var onFriday = CalculatorAt(now).DueOccurrences(Schedule(sendTime, 5), Toronto);
        var onSaturday = CalculatorAt(now).DueOccurrences(Schedule(sendTime, 6), Toronto);

        var occurrence = Assert.Single(onFriday);
        Assert.Equal(Utc(2026, 1, 3, 4, 30), occurrence.ScheduledFor);
        Assert.Equal(new DateOnly(2026, 1, 2), occurrence.LocalDate);
        Assert.Empty(onSaturday);
    }

    [Fact]
    public void Southern_hemisphere_gap_resolves_against_the_users_own_zone()
    {
        // Sydney jumps 02:00 AEST (+10) → 03:00 AEDT (+11) on 2026-10-04, i.e. at
        // 16:00Z the previous UTC day. The occurrence still belongs to local 2026-10-04.
        var calculator = CalculatorAt(Utc(2026, 10, 3, 15, 50));

        var occurrence = Assert.Single(
            calculator.DueOccurrences(Schedule(new TimeOnly(2, 30), 0), "Australia/Sydney"));

        Assert.Equal(Utc(2026, 10, 3, 16, 0), occurrence.ScheduledFor);
        Assert.Equal(new DateOnly(2026, 10, 4), occurrence.LocalDate);
    }

    [Fact]
    public void Half_hour_offset_zone_resolves_correctly()
    {
        // Asia/Kolkata is UTC+5:30 year-round: 07:00 local is 01:30Z.
        var calculator = CalculatorAt(Utc(2026, 3, 1, 1, 30));

        var occurrence = Assert.Single(
            calculator.DueOccurrences(Schedule(new TimeOnly(7, 0), EveryDay), "Asia/Kolkata"));

        Assert.Equal(Utc(2026, 3, 1, 1, 30), occurrence.ScheduledFor);
        Assert.Equal(new DateOnly(2026, 3, 1), occurrence.LocalDate);
    }

    [Fact]
    public void Occurrence_beyond_the_lookahead_window_is_not_due_yet()
    {
        var calculator = CalculatorAt(Utc(2026, 3, 1, 11, 0));

        Assert.Empty(calculator.DueOccurrences(Schedule(new TimeOnly(7, 0), EveryDay), Toronto));
    }

    [Fact]
    public void Window_includes_its_lower_bound_and_excludes_its_upper()
    {
        var schedule = Schedule(new TimeOnly(7, 0), EveryDay);

        // 07:00 EST is 12:00Z: exactly `now` in the first run, exactly `now + 30 min`
        // in the second.
        var atLowerBound = CalculatorAt(Utc(2026, 3, 1, 12, 0)).DueOccurrences(schedule, Toronto);
        var atUpperBound = CalculatorAt(Utc(2026, 3, 1, 11, 30)).DueOccurrences(schedule, Toronto);

        Assert.Equal(Utc(2026, 3, 1, 12, 0), Assert.Single(atLowerBound).ScheduledFor);
        Assert.Empty(atUpperBound);
    }

    [Fact]
    public void Day_not_in_days_of_week_produces_nothing()
    {
        // 2026-03-01 is a Sunday; this schedule runs Mondays and Wednesdays.
        var calculator = CalculatorAt(Utc(2026, 3, 1, 11, 45));

        Assert.Empty(calculator.DueOccurrences(Schedule(new TimeOnly(7, 0), 1, 3), Toronto));
    }

    [Fact]
    public void Unknown_timezone_id_throws_rather_than_silently_skipping()
    {
        var calculator = CalculatorAt(Utc(2026, 3, 1, 11, 45));

        Assert.Throws<TimeZoneNotFoundException>(
            () => calculator.DueOccurrences(Schedule(new TimeOnly(7, 0), EveryDay), "Mars/Olympus_Mons"));
    }
}
