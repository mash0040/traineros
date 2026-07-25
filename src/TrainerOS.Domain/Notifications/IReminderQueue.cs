using System.Text.Json;
using System.Text.Json.Serialization;

namespace TrainerOS.Domain.Notifications;

// notifications.md §Queue: the message is a pointer, not a payload — the delivery row is
// the state, so nothing can drift between queue and database and no email content goes
// stale in a queued message. This is the whole wire contract between the scheduler (#37)
// and the worker (#38).
public sealed record ReminderMessage([property: JsonPropertyName("delivery_id")] Guid DeliveryId)
{
    /// <summary>
    /// Reads a message body back into the contract, or null if it isn't one.
    /// </summary>
    // Tolerates the base64 form as well as raw JSON. The queue is written with base64
    // encoding to match the Functions host's default decoding, but that default is one
    // host.json setting away from changing — and a mismatch there would otherwise turn
    // every reminder into a poison message. Callers log which form arrived.
    public static ReminderMessage? TryParse(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return null;
        }

        return Deserialize(body) ?? Deserialize(DecodeBase64(body));
    }

    private static ReminderMessage? Deserialize(string? json)
    {
        if (json is null)
        {
            return null;
        }

        try
        {
            var message = JsonSerializer.Deserialize<ReminderMessage>(json);
            return message?.DeliveryId == Guid.Empty ? null : message;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? DecodeBase64(string body)
    {
        Span<byte> buffer = new byte[body.Length];
        return Convert.TryFromBase64String(body, buffer, out var written)
            ? System.Text.Encoding.UTF8.GetString(buffer[..written])
            : null;
    }
}

// The transport seam, alongside INotificationSender: the scheduler and worker depend on "a
// queue", Azure Queue Storage is one implementation, and tests get to assert what was
// enqueued — and when it becomes visible — without an emulator.
public interface IReminderQueue
{
    /// <summary>
    /// Enqueues a delivery pointer that stays invisible for <paramref name="visibilityTimeout"/>.
    /// </summary>
    // The delay is how an occurrence scheduled up to 30 minutes out is delivered *at* its
    // moment rather than as soon as the scheduler noticed it: the queue holds the message,
    // so the worker's first sight of it is already the send time.
    Task EnqueueAsync(Guid deliveryId, TimeSpan visibilityTimeout, CancellationToken cancellationToken = default);

    /// <summary>
    /// Pushes an in-flight message's next visibility out by <paramref name="visibilityTimeout"/> —
    /// the per-attempt backoff the worker sets before it throws (notifications.md §Retry).
    /// </summary>
    Task DelayRetryAsync(
        string messageId, string popReceipt, TimeSpan visibilityTimeout, CancellationToken cancellationToken = default);
}
