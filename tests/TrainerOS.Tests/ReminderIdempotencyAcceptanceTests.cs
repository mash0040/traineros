using System.Text.Json;

using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;
using TrainerOS.Domain.Notifications;
using TrainerOS.Functions;

using ProgramEntity = TrainerOS.Domain.Entities.Program;

namespace TrainerOS.Tests;

// PRODUCT.md §Definition of shipped, written as a test: "one real reminder email that a
// duplicate scheduler run did not duplicate."
//
// Every other reminder test isolates one component behind fakes. This one refuses to: the
// real ReminderScheduler and the real ReminderWorker run against one database, connected by
// a queue that carries the same JSON body StorageReminderQueue writes, and each component
// gets its own DbContext exactly as the Functions host hands it one per invocation. Nothing
// here asserts on a mechanism — the assertions are on outcomes a client would notice: how
// many rows exist, and how many emails arrived.
//
// The three mechanisms under test were built separately and never yet run together:
//   #17  unique index on idempotency_key
//   #37  INSERT ... ON CONFLICT DO NOTHING, and enqueue only rows actually inserted
//   #38  the worker's status guard (a delivery already 'sent' is acked, not resent)
// Any one of them failing shows up here as a second row or a second email.
public sealed class ReminderIdempotencyAcceptanceTests : IDisposable
{
    // Monday 2026-01-05, 06:50 in Toronto (EST, nowhere near a DST edge) — ten minutes
    // before the 07:00 reminder, so the occurrence sits inside the 30-minute lookahead.
    private static readonly DateTimeOffset TenToSeven = new(2026, 1, 5, 11, 50, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset SevenLocal = new(2026, 1, 5, 12, 0, 0, TimeSpan.Zero);

    private static readonly PauseTokenSigner PauseTokens = new("acceptance-test-pause-signing-key-32c");
    private const string ClientEmail = "client@example.com";

    private readonly SqliteConnection _connection;
    private readonly FakeClock _clock = new() { Now = TenToSeven };
    private readonly PipelineQueue _queue = new();
    private readonly RecordingSender _sender = new();

    private readonly Guid _trainerId = Guid.NewGuid();
    private readonly Guid _clientId = Guid.NewGuid();
    private readonly Guid _scheduleId = Guid.NewGuid();

    public ReminderIdempotencyAcceptanceTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        using var db = NewContext();
        db.Database.EnsureCreated();

        db.Add(new User
        {
            Id = _trainerId, Role = Roles.Trainer, Email = "trainer@example.com", DisplayName = "Trainer",
            Timezone = "America/Toronto", IsActive = true, CreatedAt = TenToSeven,
        });
        db.Add(new User
        {
            Id = _clientId, Role = Roles.Client, Email = ClientEmail, DisplayName = "Client",
            TrainerId = _trainerId, Timezone = "America/Toronto", IsActive = true, CreatedAt = TenToSeven,
        });
        db.Add(new NotificationSchedule
        {
            Id = _scheduleId, TrainerId = _trainerId, ClientId = _clientId, Kind = "workout_reminder",
            SendTime = new TimeOnly(7, 0), DaysOfWeek = [1, 2, 3, 4, 5], Enabled = true,
        });

        var programId = Guid.NewGuid();
        var dayId = Guid.NewGuid();
        var exerciseId = Guid.NewGuid();
        db.Add(new ProgramEntity
        {
            Id = programId, TrainerId = _trainerId, ClientId = _clientId, Title = "Winter Block",
            Status = ProgramStatuses.Active, CreatedAt = TenToSeven, UpdatedAt = TenToSeven,
        });
        db.Add(new ProgramDay { Id = dayId, ProgramId = programId, Title = "Day A", Position = 1 });
        db.Add(new Exercise
        {
            Id = exerciseId, TrainerId = _trainerId, Name = "Back Squat", IsActive = true, CreatedAt = TenToSeven,
        });
        db.Add(new ProgramDayExercise
        {
            Id = Guid.NewGuid(), ProgramDayId = dayId, ExerciseId = exerciseId,
            Position = 1, TargetSets = 3, TargetReps = "5",
        });

        db.SaveChanges();
    }

    public void Dispose() => _connection.Dispose();

    // A fresh context per component call: the Functions host scopes one per invocation, and
    // sharing a change tracker across the scheduler and the worker would let this test pass
    // on cached entities that production never sees.
    private TrainerOsDbContext NewContext() => new(new DbContextOptionsBuilder<TrainerOsDbContext>()
        .UseSqlite(_connection)
        .Options);

    private async Task<ReminderSchedulerSummary> RunSchedulerAsync()
    {
        using var db = NewContext();
        var scheduler = new ReminderScheduler(
            db, new ReminderOccurrenceCalculator(_clock), _queue, _clock, NullLogger<ReminderScheduler>.Instance);
        return await scheduler.RunAsync();
    }

    private async Task<ReminderOutcome> RunWorkerAsync(Guid deliveryId)
    {
        using var db = NewContext();
        var worker = new ReminderWorker(
            db, _sender, _queue, new AppBaseUrl("http://localhost:5173"), PauseTokens, _clock,
            NullLogger<ReminderWorker>.Instance);
        return await worker.ProcessAsync(deliveryId);
    }

    /// <summary>Delivers every queued message to the worker, the way the queue trigger would.</summary>
    private async Task<List<ReminderOutcome>> DrainQueueAsync()
    {
        var outcomes = new List<ReminderOutcome>();
        foreach (var deliveryId in _queue.TakeAll())
        {
            outcomes.Add(await RunWorkerAsync(deliveryId));
        }

        return outcomes;
    }

    private List<NotificationDelivery> Deliveries()
    {
        using var db = NewContext();
        return db.NotificationDeliveriesForTrainer(_trainerId).AsNoTracking().ToList();
    }

    private List<EmailMessage> SentEmails() => _sender.SentTo(ClientEmail);

    [Fact]
    public async Task Duplicate_scheduler_run_yields_one_delivery_row_and_one_email()
    {
        // The gate itself. Two ticks see the same occurrence — guaranteed, not hypothetical:
        // a 15-minute timer against a 30-minute lookahead overlaps on every single run.
        var first = await RunSchedulerAsync();
        _clock.Now = TenToSeven.AddMinutes(5);
        var second = await RunSchedulerAsync();

        Assert.Equal(1, first.Inserted);
        Assert.Equal(1, first.Enqueued);
        // The second run recognises the occurrence and declines to act on it twice.
        Assert.Equal(0, second.Inserted);
        Assert.Equal(1, second.AlreadyScheduled);
        Assert.Equal(0, second.Enqueued);

        // One row, because the unique index refused the second insert (#17 + #37).
        var delivery = Assert.Single(Deliveries());
        Assert.Equal($"{_scheduleId}:2026-01-05", delivery.IdempotencyKey);

        // One message, because only an actually-inserted row gets enqueued (#37).
        _clock.Now = SevenLocal;
        var outcomes = await DrainQueueAsync();

        Assert.Equal([ReminderOutcome.Sent], outcomes);
        var email = Assert.Single(SentEmails());
        Assert.Contains("Winter Block", email.Body);
        Assert.Equal(DeliveryStatuses.Sent, Assert.Single(Deliveries()).Status);
        Assert.Equal(1, Assert.Single(Deliveries()).Attempts);
    }

    [Fact]
    public async Task Redelivered_message_does_not_produce_a_second_email()
    {
        // At-least-once is a promise the queue makes and this system absorbs: the same
        // message can arrive twice even when the scheduler behaved perfectly (#38's guard).
        await RunSchedulerAsync();
        _clock.Now = SevenLocal;
        var deliveryId = Assert.Single(Deliveries()).Id;

        var first = await RunWorkerAsync(deliveryId);
        var second = await RunWorkerAsync(deliveryId);

        Assert.Equal(ReminderOutcome.Sent, first);
        Assert.Equal(ReminderOutcome.AlreadyHandled, second);
        Assert.Single(SentEmails());
        Assert.Equal(1, Assert.Single(Deliveries()).Attempts);
    }

    [Fact]
    public async Task Scheduler_tick_after_the_send_neither_reinserts_nor_resurrects()
    {
        // The sweep is the one component that deliberately re-enqueues, so it is also the
        // one that could resend a delivered reminder. It looks only at 'pending' rows, and
        // this proves it: the tick runs well past the sweep age with the occurrence still
        // inside the lookahead.
        await RunSchedulerAsync();
        _clock.Now = SevenLocal;
        await DrainQueueAsync();

        _clock.Now = SevenLocal.Add(ReminderScheduler.PendingSweepAge).AddMinutes(5);
        var afterTheSend = await RunSchedulerAsync();

        Assert.Equal(0, afterTheSend.Inserted);
        Assert.Equal(0, afterTheSend.Enqueued);
        Assert.Equal(0, afterTheSend.Swept);
        Assert.Empty(await DrainQueueAsync());
        Assert.Single(Deliveries());
        Assert.Single(SentEmails());
    }

    [Fact]
    public async Task Sweep_recovery_after_a_failed_enqueue_still_sends_exactly_once()
    {
        // The nastiest ordering in the system: the row commits, the enqueue does not, and a
        // later tick has to recover it. Recovery is where a naive fix double-sends — the
        // sweep re-enqueues while the original insert is still remembered.
        _queue.FailEnqueues = true;
        var blocked = await RunSchedulerAsync();
        Assert.Equal(1, blocked.Inserted);
        Assert.Equal(1, blocked.EnqueueFailures);
        Assert.Equal(DeliveryStatuses.Pending, Assert.Single(Deliveries()).Status);

        _queue.FailEnqueues = false;
        _clock.Now = SevenLocal.Add(ReminderScheduler.PendingSweepAge).AddMinutes(5);
        var recovery = await RunSchedulerAsync();

        Assert.Equal(0, recovery.Inserted);
        Assert.Equal(1, recovery.Swept);
        Assert.Equal([ReminderOutcome.Sent], await DrainQueueAsync());
        Assert.Single(Deliveries());
        Assert.Single(SentEmails());
    }

    [Fact]
    public async Task Second_row_for_the_same_occurrence_is_impossible_at_the_database_level()
    {
        // The floor under all of the above. The scheduler's ON CONFLICT clause is only ever
        // as good as the constraint it names, so this asserts the constraint itself rather
        // than inferring it from the scheduler behaving well: an insert that bypasses the
        // scheduler entirely still cannot duplicate an occurrence (#17).
        await RunSchedulerAsync();
        var existing = Assert.Single(Deliveries());

        using var db = NewContext();
        db.Add(new NotificationDelivery
        {
            Id = Guid.NewGuid(),
            ScheduleId = existing.ScheduleId,
            UserId = existing.UserId,
            Channel = existing.Channel,
            ScheduledFor = existing.ScheduledFor,
            IdempotencyKey = existing.IdempotencyKey,
            Status = DeliveryStatuses.Pending,
            Attempts = 0,
        });

        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
        Assert.Single(Deliveries());
    }

    // Stands in for Azure Queue Storage, carrying the same JSON body StorageReminderQueue
    // writes so the wire contract is exercised rather than bypassed. Visibility timeouts are
    // recorded but not simulated — when a message becomes visible is #39's question; this
    // test is about how many of them there are.
    private sealed class PipelineQueue : IReminderQueue
    {
        private readonly List<string> _bodies = [];

        public bool FailEnqueues { get; set; }

        public Task EnqueueAsync(Guid deliveryId, TimeSpan visibilityTimeout, CancellationToken cancellationToken = default)
        {
            if (FailEnqueues)
            {
                throw new InvalidOperationException("queue unavailable");
            }

            _bodies.Add(JsonSerializer.Serialize(new ReminderMessage(deliveryId)));
            return Task.CompletedTask;
        }

        public Task DelayRetryAsync(
            string messageId, string popReceipt, TimeSpan visibilityTimeout, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public List<Guid> TakeAll()
        {
            var deliveryIds = _bodies
                .Select(body => ReminderMessage.TryParse(body)!.DeliveryId)
                .ToList();
            _bodies.Clear();
            return deliveryIds;
        }
    }
}
