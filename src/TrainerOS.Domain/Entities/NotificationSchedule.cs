namespace TrainerOS.Domain.Entities;

public class NotificationSchedule
{
    public Guid Id { get; set; }
    public Guid TrainerId { get; set; }
    public Guid ClientId { get; set; }
    public required string Kind { get; set; }
    public TimeOnly SendTime { get; set; }
    public required int[] DaysOfWeek { get; set; }
    public bool Enabled { get; set; }
}
