using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;
using TrainerOS.Domain.Notifications;
using TrainerOS.Functions;

namespace TrainerOS.Tests;

// notifications.md §Scheduler end to end, minus the transport: SQLite in-memory so the
// ON CONFLICT insert and the sweep query are real SQL, a recording queue so "what got
// enqueued" is assertable without Azurite, and FakeClock so occurrences land where the test
// says they do.
//
// The fixed instant is Monday 2026-01-05 11:50Z — 06:50 in Toronto (EST, no DST anywhere
// near it), ten minutes before a 07:00 reminder, i.e. inside the 30 min lookahead.
public sealed class ReminderSchedulerTests : IDisposable
{
    private static readonly DateTimeOffset TenToSeven = new(2026, 1, 5, 11, 50, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset SevenLocal = new(2026, 1, 5, 12, 0, 0, TimeSpan.Zero);
    private static readonly int[] Weekdays = [1, 2, 3, 4, 5];

    private readonly SqliteConnection _connection;
    private readonly TrainerOsDbContext _db;
    private readonly FakeClock _clock = new() { Now = TenToSeven };
    private readonly RecordingQueue _queue = new();
    private readonly CapturingLogger<ReminderScheduler> _logger = new();

    private readonly Guid _trainerId = Guid.NewGuid();

    public ReminderSchedulerTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        _db = new TrainerOsDbContext(new DbContextOptionsBuilder<TrainerOsDbContext>()
            .UseSqlite(_connection)
            .Options);
        _db.Database.EnsureCreated();

        _db.Add(new User
        {
            Id = _trainerId, Role = Roles.Trainer, Email = "trainer@example.com", DisplayName = "Trainer",
            Timezone = "America/Toronto", IsActive = true, CreatedAt = TenToSeven,
        });
        _db.SaveChanges();
        _db.ChangeTracker.Clear();
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    private ReminderScheduler Scheduler() => new(
        _db, new ReminderOccurrenceCalculator(_clock), _queue, _clock, _logger);

    private Guid SeedClient(string tag, string timezone)
    {
        var id = Guid.NewGuid();
        _db.Add(new User
        {
            Id = id, Role = Roles.Client, Email = $"client-{tag}@example.com", DisplayName = $"Client {tag}",
            TrainerId = _trainerId, Timezone = timezone, IsActive = true, CreatedAt = TenToSeven,
        });
        _db.SaveChanges();
        _db.ChangeTracker.Clear();
        return id;
    }

    private Guid SeedSchedule(Guid clientId, bool enabled = true)
    {
        var id = Guid.NewGuid();
        _db.Add(new NotificationSchedule
        {
            Id = id, TrainerId = _trainerId, ClientId = clientId, Kind = "workout_reminder",
            SendTime = new TimeOnly(7, 0), DaysOfWeek = Weekdays, Enabled = enabled,
        });
        _db.SaveChanges();
        _db.ChangeTracker.Clear();
        return id;
    }

    private Guid SeedDelivery(Guid scheduleId, Guid clientId, DateTimeOffset scheduledFor, string status)
    {
        var id = Guid.NewGuid();
        _db.Add(new NotificationDelivery
        {
            Id = id, ScheduleId = scheduleId, UserId = clientId, Channel = "email",
            ScheduledFor = scheduledFor, IdempotencyKey = $"{scheduleId}:{scheduledFor:yyyy-MM-dd}-{status}",
            Status = status, Attempts = 0,
        });
        _db.SaveChanges();
        _db.ChangeTracker.Clear();
        return id;
    }

    private List<NotificationDelivery> Deliveries()
        => _db.NotificationDeliveriesForTrainer(_trainerId).AsNoTracking().ToList();

    [Fact]
    public async Task Due_occurrence_becomes_a_pending_delivery_and_one_queue_message()
    {
        var clientId = SeedClient("toronto", "America/Toronto");
        var scheduleId = SeedSchedule(clientId);

        var summary = await Scheduler().RunAsync();

        var delivery = Assert.Single(Deliveries());
        Assert.Equal(scheduleId, delivery.ScheduleId);
        Assert.Equal(clientId, delivery.UserId);
        Assert.Equal("email", delivery.Channel);
        Assert.Equal(DeliveryStatuses.Pending, delivery.Status);
        Assert.Equal(0, delivery.Attempts);
        Assert.Equal(SevenLocal, delivery.ScheduledFor);
        Assert.Equal($"{scheduleId}:2026-01-05", delivery.IdempotencyKey);

        Assert.Equal([delivery.Id], _queue.Enqueued);
        Assert.Equal(new ReminderSchedulerSummary(1, 1, 1, 0, 1, 0, 0, 0), summary);
    }

    [Fact]
    public async Task Rerun_inside_the_same_window_inserts_nothing_and_enqueues_nothing()
    {
        // The 15 min timer against a 30 min lookahead guarantees this overlap on every run;
        // idempotency_key collapses it, and a conflict must not produce a second message.
        var clientId = SeedClient("toronto", "America/Toronto");
        SeedSchedule(clientId);

        var first = await Scheduler().RunAsync();
        _clock.Now = TenToSeven.AddMinutes(5);
        var second = await Scheduler().RunAsync();

        Assert.Single(Deliveries());
        Assert.Single(_queue.Enqueued);
        Assert.Equal(1, first.Inserted);
        Assert.Equal(new ReminderSchedulerSummary(1, 1, 0, 1, 0, 0, 0, 0), second);
    }

    [Fact]
    public async Task Each_schedule_resolves_against_its_own_clients_timezone()
    {
        // Same 07:00 send time, two clients: 07:00 in Toronto is due, 07:00 in Kolkata
        // (UTC+5:30, already 17:20 local) is not.
        var toronto = SeedClient("toronto", "America/Toronto");
        var torontoSchedule = SeedSchedule(toronto);
        SeedSchedule(SeedClient("kolkata", "Asia/Kolkata"));

        var summary = await Scheduler().RunAsync();

        Assert.Equal(torontoSchedule, Assert.Single(Deliveries()).ScheduleId);
        Assert.Equal(2, summary.SchedulesConsidered);
        Assert.Equal(1, summary.Inserted);
    }

    [Fact]
    public async Task Disabled_schedule_is_never_considered()
    {
        SeedSchedule(SeedClient("toronto", "America/Toronto"), enabled: false);

        var summary = await Scheduler().RunAsync();

        Assert.Empty(Deliveries());
        Assert.Empty(_queue.Enqueued);
        Assert.Equal(0, summary.SchedulesConsidered);
    }

    [Fact]
    public async Task Unresolvable_timezone_is_skipped_and_logged_while_the_run_continues()
    {
        // The decision this pins: one client's broken timezone id must not cost every other
        // client their reminder. Skipped, warned about, and healed by the next tick.
        SeedSchedule(SeedClient("mars", "Mars/Olympus_Mons"));
        var toronto = SeedClient("toronto", "America/Toronto");
        var torontoSchedule = SeedSchedule(toronto);

        var summary = await Scheduler().RunAsync();

        Assert.Equal(torontoSchedule, Assert.Single(Deliveries()).ScheduleId);
        Assert.Equal(1, summary.Inserted);
        Assert.Equal(1, summary.TimezoneFailures);

        var warning = Assert.Single(_logger.Entries, e => e.Level == LogLevel.Warning);
        Assert.Contains("Mars/Olympus_Mons", warning.Message);
    }

    [Fact]
    public async Task Enqueue_failure_leaves_the_row_pending_and_does_not_abort_the_run()
    {
        // notifications.md §Failure modes, queue unavailable: rows are still inserted. An
        // occurrence not inserted while its window is open is lost for good; an occurrence
        // not enqueued is recovered by the sweep, so the insert pass must survive.
        SeedSchedule(SeedClient("a", "America/Toronto"));
        SeedSchedule(SeedClient("b", "America/Toronto"));
        _queue.Fails = true;

        var summary = await Scheduler().RunAsync();

        var deliveries = Deliveries();
        Assert.Equal(2, deliveries.Count);
        Assert.All(deliveries, d => Assert.Equal(DeliveryStatuses.Pending, d.Status));
        Assert.Empty(_queue.Enqueued);
        Assert.Equal(2, summary.Inserted);
        Assert.Equal(0, summary.Enqueued);
        Assert.Equal(2, summary.EnqueueFailures);
        Assert.Equal(2, _logger.Entries.Count(e => e.Level == LogLevel.Error));
    }

    [Fact]
    public async Task Sweep_re_enqueues_a_row_whose_enqueue_failed_after_its_insert_committed()
    {
        // The whole recovery path in one test: run with a dead queue, then run again once the
        // row is 25 min past its moment. Same row, no second insert, one message at last.
        SeedSchedule(SeedClient("toronto", "America/Toronto"));
        _queue.Fails = true;
        await Scheduler().RunAsync();

        _queue.Fails = false;
        _clock.Now = SevenLocal.Add(ReminderScheduler.PendingSweepAge).AddMinutes(5);
        var recovery = await Scheduler().RunAsync();

        var delivery = Assert.Single(Deliveries());
        Assert.Equal([delivery.Id], _queue.Enqueued);
        Assert.Equal(1, recovery.Swept);
        Assert.Equal(0, recovery.Inserted);
    }

    [Fact]
    public async Task Sweep_leaves_a_row_that_is_not_yet_past_the_sweep_age()
    {
        // Still inside the window where an in-flight message could plausibly deliver it;
        // re-enqueueing here would just add a duplicate.
        SeedSchedule(SeedClient("toronto", "America/Toronto"));
        _queue.Fails = true;
        await Scheduler().RunAsync();

        _queue.Fails = false;
        _clock.Now = SevenLocal.AddMinutes(10);
        var summary = await Scheduler().RunAsync();

        Assert.Empty(_queue.Enqueued);
        Assert.Equal(0, summary.Swept);
    }

    [Fact]
    public async Task Sweep_takes_pending_rows_only()
    {
        // 'sent' and 'dead' are terminal; 'failed' is mid-retry and owned by the queue's
        // visibility timeout, so sweeping it would race the platform's own redelivery.
        var clientId = SeedClient("toronto", "America/Toronto");
        var scheduleId = SeedSchedule(clientId, enabled: false);
        var stale = SevenLocal.AddHours(-2);

        var pending = SeedDelivery(scheduleId, clientId, stale, DeliveryStatuses.Pending);
        SeedDelivery(scheduleId, clientId, stale, DeliveryStatuses.Sent);
        SeedDelivery(scheduleId, clientId, stale, DeliveryStatuses.Failed);
        SeedDelivery(scheduleId, clientId, stale, DeliveryStatuses.Dead);

        var summary = await Scheduler().RunAsync();

        Assert.Equal([pending], _queue.Enqueued);
        Assert.Equal(1, summary.Swept);
    }

    private sealed class RecordingQueue : IReminderQueue
    {
        public List<Guid> Enqueued { get; } = [];

        public bool Fails { get; set; }

        public Task EnqueueAsync(Guid deliveryId, CancellationToken cancellationToken = default)
        {
            if (Fails)
            {
                throw new InvalidOperationException("queue unavailable");
            }

            Enqueued.Add(deliveryId);
            return Task.CompletedTask;
        }
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<(LogLevel Level, string Message)> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
            Exception? exception, Func<TState, Exception?, string> formatter)
            => Entries.Add((logLevel, formatter(state, exception)));
    }
}
