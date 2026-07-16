using Microsoft.Extensions.Logging;
using TrainerOS.Domain.Notifications;

namespace TrainerOS.Tests;

public class ConsoleNotificationSenderTests
{
    private sealed class CapturingLogger : ILogger<ConsoleNotificationSender>
    {
        public List<(LogLevel Level, string Message)> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
            Exception? exception, Func<TState, Exception?, string> formatter)
            => Entries.Add((logLevel, formatter(state, exception)));
    }

    [Fact]
    public async Task Logs_recipient_subject_and_body_including_magic_link_url()
    {
        var logger = new CapturingLogger();
        var sender = new ConsoleNotificationSender(logger);

        await sender.SendAsync(new EmailMessage(
            "client@example.com",
            "Log in to TrainerOS",
            "Tap to continue: https://localhost:5216/auth/verify?token=abc123"));

        var entry = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Information, entry.Level);
        Assert.Contains("client@example.com", entry.Message);
        Assert.Contains("Log in to TrainerOS", entry.Message);
        Assert.Contains("https://localhost:5216/auth/verify?token=abc123", entry.Message);
    }
}
