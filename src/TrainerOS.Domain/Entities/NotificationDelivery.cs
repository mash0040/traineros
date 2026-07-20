namespace TrainerOS.Domain.Entities;

public class NotificationDelivery
{
    public Guid Id { get; set; }
    public Guid ScheduleId { get; set; }
    public Guid UserId { get; set; }
    public required string Channel { get; set; }
    public DateTimeOffset ScheduledFor { get; set; }
    public required string IdempotencyKey { get; set; }
    public required string Status { get; set; }
    public int Attempts { get; set; }
    public string? LastError { get; set; }
    public DateTimeOffset? SentAt { get; set; }
}
