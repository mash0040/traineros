namespace TrainerOS.Domain.Notifications;

// The adapter seam from notifications.md §Email content / architecture.md §Stack:
// providers (Resend, dev console) are swappable implementations. Auth (epic #3)
// depends on this interface only — the Resend binding arrives with epic #6.
public interface INotificationSender
{
    Task SendAsync(EmailMessage message, CancellationToken cancellationToken = default);
}

public sealed record EmailMessage(string To, string Subject, string Body);
