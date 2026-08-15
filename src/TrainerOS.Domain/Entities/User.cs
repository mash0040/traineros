namespace TrainerOS.Domain.Entities;

public class User
{
    public Guid Id { get; set; }
    public required string Role { get; set; }
    public required string Email { get; set; }
    public required string DisplayName { get; set; }
    public Guid? TrainerId { get; set; }
    public required string Timezone { get; set; }

    // What this person is shown and what their typed weights mean (#99). Never what is stored:
    // logged_sets.weight_kg is canonical kilograms whatever this says. See WeightUnits.
    //
    // Defaulted rather than `required`, unlike every other member here. The others have no
    // sensible default — a user with no email or no timezone is a broken row — whereas this
    // column's default is declared in the schema itself (003_UserWeightUnit: NOT NULL DEFAULT
    // 'lb'), so an entity that insisted every construction site restate it would be demanding
    // ceremony the database already answers.
    public string WeightUnit { get; set; } = WeightUnits.Default;

    public string? PasswordHash { get; set; }
    public bool IsActive { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
