namespace TrainerOS.Domain.Entities;

public class Exercise
{
    public Guid Id { get; set; }
    public Guid TrainerId { get; set; }
    public required string Name { get; set; }
    public string? VideoUrl { get; set; }
    public string? Cues { get; set; }

    // Not in database.md §Tables, but required by its resolved question 1 and
    // api.md ("delete = PATCH is_active=false"): exercises soft-delete, never hard-delete.
    public bool IsActive { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}
