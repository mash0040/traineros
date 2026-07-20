namespace TrainerOS.Domain.Entities;

public class Session
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}
