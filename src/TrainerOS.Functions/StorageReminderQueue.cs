using System.Text.Json;

using Azure.Storage.Queues;

using TrainerOS.Domain.Notifications;

namespace TrainerOS.Functions;

// notifications.md §Queue: Azure Queue Storage, single queue 'reminders', body
// { "delivery_id": "<uuid>" } and nothing else. Local dev runs against Azurite through the
// same code path — that's the point of the emulator.
//
// Base64 message encoding is not decoration: the Functions host's queue trigger decodes
// base64 by default, so a raw-SDK sender that skips it produces messages the worker (#38)
// cannot read. Setting it on the client keeps that agreement in one line instead of a
// host.json override.
public sealed class StorageReminderQueue : IReminderQueue
{
    public const string QueueName = "reminders";

    private readonly QueueClient _client;
    private bool _queueEnsured;

    public StorageReminderQueue(string connectionString)
    {
        _client = new QueueClient(
            connectionString,
            QueueName,
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });
    }

    public async Task EnqueueAsync(Guid deliveryId, CancellationToken cancellationToken = default)
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
        await _client.SendMessageAsync(body, cancellationToken);
    }
}
