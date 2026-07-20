namespace TrainerOS.Domain.Entities;

public class User
{
    public Guid Id { get; set; }
    public required string Role { get; set; }
    public required string Email { get; set; }
    public required string DisplayName { get; set; }
    public Guid? TrainerId { get; set; }
    public required string Timezone { get; set; }
    public string? PasswordHash { get; set; }
    public bool IsActive { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
