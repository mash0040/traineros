using System.Text.Json;

using Azure.Storage.Queues;

using TrainerOS.Domain.Notifications;

namespace TrainerOS.Functions;

// notifications.md §Queue: Azure Queue Storage, single queue 'reminders', body
// { "delivery_id": "<uuid>" } and nothing else. Local dev runs against Azurite through the
// same code path — that's the point of the emulator.
//
// Base64 message encoding is not decoration: the Functions host's queue trigger decodes
// base64 by default, so a raw-SDK sender that skips it produces messages the worker
// cannot read. Setting it on the client keeps that agreement in one line instead of a
// host.json override.
public sealed class StorageReminderQueue : IReminderQueue
{
    public const string QueueName = "reminders";

    // The platform's own dead-letter queue: after maxDequeueCount failures the host moves
    // the message here itself. We only read from it (ReminderPoisonHandler).
    public const string PoisonQueueName = QueueName + "-poison";

    private readonly QueueClient _client;
    private bool _queueEnsured;

    public StorageReminderQueue(string connectionString)
    {
        _client = new QueueClient(
            connectionString,
            QueueName,
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });
    }

    public async Task EnqueueAsync(
        Guid deliveryId, TimeSpan visibilityTimeout, CancellationToken cancellationToken = default)
    {
        // Azurite starts with no queues, and a fresh storage account has none either. The
        // flag is set only on success, so a transient failure retries on the next send
        // rather than caching itself for the life of the process.
        if (!_queueEnsured)
        {
            await _client.CreateIfNotExistsAsync(cancellationToken: cancellationToken);
            _queueEnsured = true;
        }

        var body = JsonSerializer.Serialize(new ReminderMessage(deliveryId));
        await _client.SendMessageAsync(
            body, visibilityTimeout, timeToLive: null, cancellationToken: cancellationToken);
    }

    public async Task DelayRetryAsync(
        string messageId, string popReceipt, TimeSpan visibilityTimeout, CancellationToken cancellationToken = default)
        // Null message text leaves the body untouched — this call only moves the clock on
        // when the message next becomes visible.
        => await _client.UpdateMessageAsync(
            messageId, popReceipt, messageText: null, visibilityTimeout, cancellationToken);
}
