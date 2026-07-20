namespace TrainerOS.Domain.Entities;

public class ProgramDay
{
    public Guid Id { get; set; }
    public Guid ProgramId { get; set; }
    public required string Title { get; set; }
    public int Position { get; set; }

    public List<ProgramDayExercise> Exercises { get; set; } = [];
}
