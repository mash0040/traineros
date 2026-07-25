using System.Text;

using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;
using TrainerOS.Domain.Notifications;
using TrainerOS.Functions;

namespace TrainerOS.Tests;

// notifications.md §Retry & dead-lettering: the platform moves a message to reminders-poison
// after maxDequeueCount failures, and this function is what makes that visible — a row that
// says 'dead' and one log line at error severity, which is v1's only alert.
public sealed class ReminderPoisonHandlerTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 1, 5, 12, 0, 0, TimeSpan.Zero);

    private readonly SqliteConnection _connection;
    private readonly TrainerOsDbContext _db;
    private readonly CapturingLogger _logger = new();

    private readonly Guid _trainerId = Guid.NewGuid();
    private readonly Guid _clientId = Guid.NewGuid();
    private readonly Guid _scheduleId = Guid.NewGuid();

    public ReminderPoisonHandlerTests()
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
            Timezone = "America/Toronto", IsActive = true, CreatedAt = Now,
        });
        _db.Add(new User
        {
            Id = _clientId, Role = Roles.Client, Email = "client@example.com", DisplayName = "Client",
            TrainerId = _trainerId, Timezone = "America/Toronto", IsActive = true, CreatedAt = Now,
        });
        _db.Add(new NotificationSchedule
        {
            Id = _scheduleId, TrainerId = _trainerId, ClientId = _clientId, Kind = "workout_reminder",
            SendTime = new TimeOnly(7, 0), DaysOfWeek = [1, 2, 3, 4, 5], Enabled = true,
        });
        _db.SaveChanges();
        _db.ChangeTracker.Clear();
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    private ReminderPoisonHandler Handler() => new(_db, _logger);

    private Guid SeedDelivery(string status, string? lastError, int attempts = 5)
    {
        var id = Guid.NewGuid();
        _db.Add(new NotificationDelivery
        {
            Id = id, ScheduleId = _scheduleId, UserId = _clientId, Channel = "email",
            ScheduledFor = Now, IdempotencyKey = $"{_scheduleId}:{id}", Status = status,
            Attempts = attempts, LastError = lastError,
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
    public async Task Poisoned_delivery_is_marked_dead_and_logged_at_error_severity()
    {
        var deliveryId = SeedDelivery(DeliveryStatuses.Failed, "421 mailbox unavailable");

        await Handler().MarkDeadAsync(deliveryId);

        var delivery = Reload(deliveryId);
        Assert.Equal(DeliveryStatuses.Dead, delivery.Status);
        // The provider's own words survive: "why did this die" is answered better by the 421
        // than by our summary of it.
        Assert.Equal("421 mailbox unavailable", delivery.LastError);

        var entry = Assert.Single(_logger.Entries);
        Assert.Equal(LogLevel.Error, entry.Level);
        Assert.Contains(deliveryId.ToString(), entry.Message);
        // The row's attempt count, not the poison message's DequeueCount — that one is always
        // 1 (the message's first delivery to the poison queue) and a live run logged exactly
        // that lie next to "retries exhausted".
        Assert.Contains("after 5 attempts", entry.Message);
    }

    [Fact]
    public async Task Poisoned_delivery_that_never_reached_a_provider_still_says_why_it_died()
    {
        var deliveryId = SeedDelivery(DeliveryStatuses.Pending, lastError: null);

        await Handler().MarkDeadAsync(deliveryId);

        Assert.Equal("dead-lettered: retries exhausted", Reload(deliveryId).LastError);
    }

    [Fact]
    public async Task Sent_delivery_is_not_overwritten_by_a_late_poison_message()
    {
        // A redelivery can succeed while an earlier copy of the message is on its way to the
        // poison queue. Marking that row dead would make the audit log lie.
        var deliveryId = SeedDelivery(DeliveryStatuses.Sent, lastError: null);

        await Handler().MarkDeadAsync(deliveryId);

        Assert.Equal(DeliveryStatuses.Sent, Reload(deliveryId).Status);
        Assert.Equal(LogLevel.Error, Assert.Single(_logger.Entries).Level);
    }

    [Fact]
    public async Task Poison_message_for_an_unknown_delivery_is_logged_not_thrown()
    {
        await Handler().MarkDeadAsync(Guid.NewGuid());

        Assert.Equal(LogLevel.Error, Assert.Single(_logger.Entries).Level);
    }

    [Theory]
    [InlineData("{\"delivery_id\":\"6f9619ff-8b86-d011-b42d-00c04fc964ff\"}")]
    [InlineData("  {\"delivery_id\":\"6f9619ff-8b86-d011-b42d-00c04fc964ff\"}  ")]
    public void Message_body_parses_as_the_wire_contract(string body)
        => Assert.Equal(
            Guid.Parse("6f9619ff-8b86-d011-b42d-00c04fc964ff"),
            ReminderMessage.TryParse(body)!.DeliveryId);

    [Fact]
    public void Base64_wrapped_body_parses_too()
    {
        // The sender base64-encodes to match the host's default decoding; if those two ever
        // disagree the worker still reads the message instead of poisoning every reminder.
        var deliveryId = Guid.NewGuid();
        var encoded = Convert.ToBase64String(
            Encoding.UTF8.GetBytes($"{{\"delivery_id\":\"{deliveryId}\"}}"));

        Assert.Equal(deliveryId, ReminderMessage.TryParse(encoded)!.DeliveryId);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json at all")]
    [InlineData("{\"delivery_id\":\"00000000-0000-0000-0000-000000000000\"}")]
    [InlineData("{\"something_else\":42}")]
    public void Unreadable_body_parses_to_null(string body)
        => Assert.Null(ReminderMessage.TryParse(body));

    private sealed class CapturingLogger : ILogger<ReminderPoisonHandler>
    {
        public List<(LogLevel Level, string Message)> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
            Exception? exception, Func<TState, Exception?, string> formatter)
            => Entries.Add((logLevel, formatter(state, exception)));
    }
}
