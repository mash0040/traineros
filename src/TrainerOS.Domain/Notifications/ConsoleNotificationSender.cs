using Microsoft.Extensions.Logging;

namespace TrainerOS.Domain.Notifications;

// Dev-only sender: the full body is logged on purpose so magic-link URLs
// can be followed straight from the console. Never bind in production.
public sealed class ConsoleNotificationSender(ILogger<ConsoleNotificationSender> logger) : INotificationSender
{
    public Task SendAsync(EmailMessage message, CancellationToken cancellationToken = default)
    {
        logger.LogInformation(
            "Outbound email (console dev sender)\nTo: {To}\nSubject: {Subject}\n{Body}",
            message.To, message.Subject, message.Body);
        return Task.CompletedTask;
    }
}
