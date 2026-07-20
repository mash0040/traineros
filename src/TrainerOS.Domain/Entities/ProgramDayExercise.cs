namespace TrainerOS.Domain.Entities;

public class ProgramDayExercise
{
    public Guid Id { get; set; }
    public Guid ProgramDayId { get; set; }
    public Guid ExerciseId { get; set; }
    public int Position { get; set; }
    public int TargetSets { get; set; }

    // Text on purpose per database.md: '8–10', 'AMRAP', 'RPE 8' are all real prescriptions.
    public required string TargetReps { get; set; }
    public string? TargetLoad { get; set; }

    public int? RestSeconds { get; set; }
    public string? Note { get; set; }
}
