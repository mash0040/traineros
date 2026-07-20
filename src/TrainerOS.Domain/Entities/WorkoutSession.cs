namespace TrainerOS.Domain.Entities;

public class WorkoutSession
{
    public Guid Id { get; set; }
    public Guid TrainerId { get; set; }
    public Guid ClientId { get; set; }
    public Guid? ProgramDayId { get; set; }
    public DateOnly PerformedOn { get; set; }
    public string? Comment { get; set; }
    public DateTimeOffset CreatedAt { get; set; }

    public List<LoggedSet> Sets { get; set; } = [];
}
