namespace TrainerOS.Domain.Entities;

public class Program
{
    public Guid Id { get; set; }
    public Guid TrainerId { get; set; }
    public Guid ClientId { get; set; }
    public required string Title { get; set; }
    public required string Status { get; set; }
    public DateOnly? StartsOn { get; set; }
    public string? Notes { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public List<ProgramDay> Days { get; set; } = [];
}
