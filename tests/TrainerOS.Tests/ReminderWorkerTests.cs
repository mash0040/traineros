using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;
using TrainerOS.Domain.Notifications;
using TrainerOS.Functions;

using ProgramEntity = TrainerOS.Domain.Entities.Program;

namespace TrainerOS.Tests;

// notifications.md §Worker, one message at a time: SQLite in-memory so the guards run as real
// queries, a recording sender so "what would have been emailed" is assertable, and FakeClock
// so staleness is a decision rather than a race.
public sealed class ReminderWorkerTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 1, 5, 12, 0, 0, TimeSpan.Zero);
    private const string BaseUrl = "http://localhost:5173";

    private readonly SqliteConnection _connection;
    private readonly TrainerOsDbContext _db;
    private readonly FakeClock _clock = new() { Now = Now };
    private readonly RecordingSender _sender = new();

    private readonly Guid _trainerId = Guid.NewGuid();
    private readonly Guid _clientId = Guid.NewGuid();
    private readonly Guid _scheduleId = Guid.NewGuid();

    public ReminderWorkerTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        _db = NewContext();
        _db.Database.EnsureCreated();

        _db.Add(new User
        {
            Id = _trainerId, Role = Roles.Trainer, Email = "trainer@example.com", DisplayName = "Trainer",
            Timezone = "America/Toronto", IsActive = true, CreatedAt = Now,
        });
        SeedClient(_clientId, "a", isActive: true);
        SeedSchedule(_scheduleId, _clientId, enabled: true);
        SeedActiveProgram(_clientId, "Winter Block", exerciseCount: 3);
        _db.SaveChanges();
        _db.ChangeTracker.Clear();
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    private TrainerOsDbContext NewContext() => new(new DbContextOptionsBuilder<TrainerOsDbContext>()
        .UseSqlite(_connection)
        .Options);

    private ReminderWorker Worker() => new(
        _db, _sender, new AppBaseUrl(BaseUrl), _clock, NullLogger<ReminderWorker>.Instance);

    private void SeedClient(Guid id, string tag, bool isActive) => _db.Add(new User
    {
        Id = id, Role = Roles.Client, Email = $"client-{tag}@example.com", DisplayName = $"Client {tag}",
        TrainerId = _trainerId, Timezone = "America/Toronto", IsActive = isActive, CreatedAt = Now,
    });

    private void SeedSchedule(Guid id, Guid clientId, bool enabled) => _db.Add(new NotificationSchedule
    {
        Id = id, TrainerId = _trainerId, ClientId = clientId, Kind = "workout_reminder",
        SendTime = new TimeOnly(7, 0), DaysOfWeek = [1, 2, 3, 4, 5], Enabled = enabled,
    });

    private void SeedActiveProgram(Guid clientId, string title, int exerciseCount, string status = ProgramStatuses.Active)
    {
        var programId = Guid.NewGuid();
        var dayId = Guid.NewGuid();

        _db.Add(new ProgramEntity
        {
            Id = programId, TrainerId = _trainerId, ClientId = clientId, Title = title,
            Status = status, CreatedAt = Now, UpdatedAt = Now,
        });
        _db.Add(new ProgramDay { Id = dayId, ProgramId = programId, Title = "Day A", Position = 1 });

        for (var position = 1; position <= exerciseCount; position++)
        {
            var exerciseId = Guid.NewGuid();
            _db.Add(new Exercise
            {
                Id = exerciseId, TrainerId = _trainerId, Name = $"{title} lift {position}",
                IsActive = true, CreatedAt = Now,
            });
            _db.Add(new ProgramDayExercise
            {
                Id = Guid.NewGuid(), ProgramDayId = dayId, ExerciseId = exerciseId,
                Position = position, TargetSets = 3, TargetReps = "8-10",
            });
        }
    }

    private Guid SeedDelivery(
        string status = DeliveryStatuses.Pending,
        DateTimeOffset? scheduledFor = null,
        Guid? scheduleId = null,
        Guid? clientId = null,
        int attempts = 0)
    {
        var id = Guid.NewGuid();
        _db.Add(new NotificationDelivery
        {
            Id = id,
            ScheduleId = scheduleId ?? _scheduleId,
            UserId = clientId ?? _clientId,
            Channel = "email",
            ScheduledFor = scheduledFor ?? Now,
            IdempotencyKey = $"{scheduleId ?? _scheduleId}:{id}",
            Status = status,
            Attempts = attempts,
        });
        _db.SaveChanges();
        _db.ChangeTracker.Clear();
        return id;
    }

    private NotificationDelivery Reload(Guid deliveryId)
    {
        _db.ChangeTracker.Clear();
        return _db.NotificationDeliveriesForTrainer(_trainerId).AsNoTracking().Single(d => d.Id == deliveryId);
    }

    [Fact]
    public async Task Pending_delivery_is_sent_and_the_row_records_the_send()
    {
        var deliveryId = SeedDelivery();

        var outcome = await Worker().ProcessAsync(deliveryId);

        var email = Assert.Single(_sender.Sent);
        Assert.Equal("client-a@example.com", email.To);
        Assert.Contains("Winter Block", email.Subject);
        Assert.Contains("Today: Winter Block — 3 exercises.", email.Body);
        Assert.Contains(BaseUrl, email.Body);

        var delivery = Reload(deliveryId);
        Assert.Equal(DeliveryStatuses.Sent, delivery.Status);
        Assert.Equal(Now, delivery.SentAt);
        Assert.Equal(1, delivery.Attempts);
        Assert.Equal(ReminderOutcome.Sent, outcome);
    }

    [Fact]
    public async Task Redelivered_message_for_a_sent_row_is_a_no_op()
    {
        // At-least-once: the queue is allowed to hand the same message over twice, and the
        // second pass must not produce a second email.
        var deliveryId = SeedDelivery(status: DeliveryStatuses.Sent);

        var outcome = await Worker().ProcessAsync(deliveryId);

        Assert.Empty(_sender.Sent);
        Assert.Equal(DeliveryStatuses.Sent, Reload(deliveryId).Status);
        Assert.Equal(ReminderOutcome.AlreadyHandled, outcome);
    }

    [Fact]
    public async Task Dead_row_is_never_resurrected()
    {
        var deliveryId = SeedDelivery(status: DeliveryStatuses.Dead);

        var outcome = await Worker().ProcessAsync(deliveryId);

        Assert.Empty(_sender.Sent);
        Assert.Equal(ReminderOutcome.AlreadyHandled, outcome);
    }

    [Fact]
    public async Task Failed_row_is_what_a_redelivery_exists_to_retry()
    {
        var deliveryId = SeedDelivery(status: DeliveryStatuses.Failed, attempts: 1);

        await Worker().ProcessAsync(deliveryId);

        Assert.Single(_sender.Sent);
        var delivery = Reload(deliveryId);
        Assert.Equal(DeliveryStatuses.Sent, delivery.Status);
        Assert.Equal(2, delivery.Attempts);
    }

    [Fact]
    public async Task Client_deactivated_after_scheduling_is_not_emailed()
    {
        // The whole reason this guard is the worker's and not the scheduler's: the flag can
        // flip in the 30 minutes between them.
        var clientId = Guid.NewGuid();
        var scheduleId = Guid.NewGuid();
        SeedClient(clientId, "inactive", isActive: false);
        SeedSchedule(scheduleId, clientId, enabled: true);
        SeedActiveProgram(clientId, "Gone Fishing", exerciseCount: 2);
        _db.SaveChanges();
        var deliveryId = SeedDelivery(scheduleId: scheduleId, clientId: clientId);

        var outcome = await Worker().ProcessAsync(deliveryId);

        Assert.Empty(_sender.Sent);
        var delivery = Reload(deliveryId);
        Assert.Equal(DeliveryStatuses.Dead, delivery.Status);
        Assert.Equal("skipped: disabled", delivery.LastError);
        Assert.Equal(ReminderOutcome.SkippedDisabled, outcome);
    }

    [Fact]
    public async Task Schedule_disabled_after_scheduling_is_not_emailed()
    {
        var clientId = Guid.NewGuid();
        var scheduleId = Guid.NewGuid();
        SeedClient(clientId, "paused", isActive: true);
        SeedSchedule(scheduleId, clientId, enabled: false);
        SeedActiveProgram(clientId, "Paused Block", exerciseCount: 2);
        _db.SaveChanges();
        var deliveryId = SeedDelivery(scheduleId: scheduleId, clientId: clientId);

        var outcome = await Worker().ProcessAsync(deliveryId);

        Assert.Empty(_sender.Sent);
        var delivery = Reload(deliveryId);
        Assert.Equal(DeliveryStatuses.Dead, delivery.Status);
        Assert.Equal("skipped: disabled", delivery.LastError);
        Assert.Equal(ReminderOutcome.SkippedDisabled, outcome);
    }

    [Fact]
    public async Task Delivery_more_than_six_hours_stale_expires_instead_of_sending()
    {
        // No 2 a.m. "time to work out" because the queue was backed up since morning.
        var deliveryId = SeedDelivery(scheduledFor: Now - ReminderWorker.StaleAfter.Add(TimeSpan.FromMinutes(1)));

        var outcome = await Worker().ProcessAsync(deliveryId);

        Assert.Empty(_sender.Sent);
        var delivery = Reload(deliveryId);
        Assert.Equal(DeliveryStatuses.Dead, delivery.Status);
        Assert.Equal("expired", delivery.LastError);
        Assert.Equal(ReminderOutcome.Expired, outcome);
    }

    [Fact]
    public async Task Delivery_still_inside_the_staleness_window_is_sent_late()
    {
        // Late is not worthless. Five hours behind still lands in the same day.
        var deliveryId = SeedDelivery(scheduledFor: Now - TimeSpan.FromHours(5));

        var outcome = await Worker().ProcessAsync(deliveryId);

        Assert.Single(_sender.Sent);
        Assert.Equal(ReminderOutcome.Sent, outcome);
    }

    [Fact]
    public async Task Client_with_no_active_program_is_marked_dead_rather_than_emailed()
    {
        var clientId = Guid.NewGuid();
        var scheduleId = Guid.NewGuid();
        SeedClient(clientId, "programless", isActive: true);
        SeedSchedule(scheduleId, clientId, enabled: true);
        SeedActiveProgram(clientId, "Last Season", exerciseCount: 2, status: ProgramStatuses.Archived);
        _db.SaveChanges();
        var deliveryId = SeedDelivery(scheduleId: scheduleId, clientId: clientId);

        var outcome = await Worker().ProcessAsync(deliveryId);

        Assert.Empty(_sender.Sent);
        var delivery = Reload(deliveryId);
        Assert.Equal(DeliveryStatuses.Dead, delivery.Status);
        Assert.Equal("skipped: no active program", delivery.LastError);
        Assert.Equal(ReminderOutcome.NoActiveProgram, outcome);
    }

    [Fact]
    public async Task Provider_failure_marks_the_row_failed_and_rethrows_for_the_queue()
    {
        var deliveryId = SeedDelivery();
        _sender.FailWith = new InvalidOperationException("Resend rejected the send request: 429");

        await Assert.ThrowsAsync<InvalidOperationException>(() => Worker().ProcessAsync(deliveryId));

        var delivery = Reload(deliveryId);
        Assert.Equal(DeliveryStatuses.Failed, delivery.Status);
        Assert.Contains("429", delivery.LastError);
        Assert.Equal(1, delivery.Attempts);
        Assert.Null(delivery.SentAt);
    }

    [Fact]
    public async Task Row_is_not_marked_sent_before_the_provider_accepts()
    {
        // The at-least-once decision, pinned: marking 'sent' first would make a crash inside
        // SendAsync lose the reminder silently. Read through a second context so the
        // assertion sees committed state, not the tracked entity.
        var deliveryId = SeedDelivery();
        string? statusDuringSend = null;
        _sender.OnSend = () =>
        {
            using var probe = NewContext();
            statusDuringSend = probe.NotificationDeliveriesForTrainer(_trainerId)
                .AsNoTracking().Single(d => d.Id == deliveryId).Status;
        };

        await Worker().ProcessAsync(deliveryId);

        Assert.Equal(DeliveryStatuses.Pending, statusDuringSend);
        Assert.Equal(DeliveryStatuses.Sent, Reload(deliveryId).Status);
    }

    [Fact]
    public async Task Email_renders_the_recipients_own_program()
    {
        // A worker that queries unscoped is the same IDOR with no URL to point at
        // (architecture.md). One exercise, so the singular renders too.
        var otherClientId = Guid.NewGuid();
        var otherScheduleId = Guid.NewGuid();
        SeedClient(otherClientId, "b", isActive: true);
        SeedSchedule(otherScheduleId, otherClientId, enabled: true);
        SeedActiveProgram(otherClientId, "Rehab Block", exerciseCount: 1);
        _db.SaveChanges();
        var deliveryId = SeedDelivery(scheduleId: otherScheduleId, clientId: otherClientId);

        await Worker().ProcessAsync(deliveryId);

        var email = Assert.Single(_sender.Sent);
        Assert.Equal("client-b@example.com", email.To);
        Assert.Contains("Today: Rehab Block — 1 exercise.", email.Body);
        Assert.DoesNotContain("Winter Block", email.Body);
    }

    [Fact]
    public async Task Message_for_an_unknown_delivery_is_acked_not_retried()
    {
        var outcome = await Worker().ProcessAsync(Guid.NewGuid());

        Assert.Empty(_sender.Sent);
        Assert.Equal(ReminderOutcome.NotFound, outcome);
    }

    private sealed class RecordingSender : INotificationSender
    {
        public List<EmailMessage> Sent { get; } = [];

        public Exception? FailWith { get; set; }

        public Action? OnSend { get; set; }

        public Task SendAsync(EmailMessage message, CancellationToken cancellationToken = default)
        {
            OnSend?.Invoke();

            if (FailWith is not null)
            {
                throw FailWith;
            }

            Sent.Add(message);
            return Task.CompletedTask;
        }
    }
}
