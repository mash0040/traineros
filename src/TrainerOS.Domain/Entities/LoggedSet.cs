namespace TrainerOS.Domain.Entities;

public class LoggedSet
{
    public Guid Id { get; set; }
    public Guid SessionId { get; set; }
    public Guid ExerciseId { get; set; }
    public Guid? ProgramDayExerciseId { get; set; }
    public int SetNumber { get; set; }
    public decimal? WeightKg { get; set; }
    public int Reps { get; set; }
    public DateTimeOffset LoggedAt { get; set; }
}
