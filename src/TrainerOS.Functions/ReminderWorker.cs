using Azure.Storage.Queues.Models;

using Microsoft.Azure.Functions.Worker;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;
using TrainerOS.Domain.Notifications;

namespace TrainerOS.Functions;

/// <summary>The SPA origin reminders link back to, validated once at startup instead of at first send.</summary>
public sealed record AppBaseUrl(string Value);

/// <summary>What one message did. Everything except <see cref="Sent"/> ends in an ack.</summary>
public enum ReminderOutcome
{
    Sent,
    NotFound,
    AlreadyHandled,
    SkippedDisabled,
    Expired,
    NoActiveProgram,
}

// notifications.md §Worker: the queue-triggered half. A message carries a delivery id and
// nothing else, so every decision here is made against the row and the client's *current*
// data — which is the point of thin messages: nothing queued can go stale.
//
// The delivery-semantics decision this file implements is at-least-once. The row is updated
// immediately after the provider accepts, never before: if the process dies in that window
// the message redelivers and the client gets a duplicate email. The alternative — claim the
// row first — is at-most-once, where the same crash loses the reminder silently. For
// reminders a rare duplicate is annoying and a silent loss defeats the feature, so the
// window is minimized and accepted rather than closed. (Closing it needs provider-side
// idempotency keys; notifications.md books that as a v1.1 hardening.)
public sealed class ReminderWorker(
    TrainerOsDbContext db,
    INotificationSender sender,
    IReminderQueue queue,
    AppBaseUrl appBaseUrl,
    TimeProvider clock,
    ILogger<ReminderWorker> logger)
{
    // notifications.md §Retry: a reminder that misses its moment is worthless — nobody wants
    // "time to work out" at 2 a.m. because the queue was backed up since morning.
    public static readonly TimeSpan StaleAfter = TimeSpan.FromHours(6);

    // notifications.md §Retry: approximate exponential, because provider outages run
    // minutes-to-hours. One entry per retryable failure — four backoffs before the fifth
    // dequeue hands the message to the poison queue.
    public static readonly TimeSpan[] RetryBackoff =
    [
        TimeSpan.FromMinutes(1),
        TimeSpan.FromMinutes(5),
        TimeSpan.FromMinutes(15),
        TimeSpan.FromMinutes(60),
    ];

    // Mirrors host.json's queues.maxDequeueCount. Kept in sync by hand because the worker
    // cannot read the host's binding configuration, and the ReminderWorkerTests assert the
    // final-attempt behaviour against this number.
    public const int MaxDequeueCount = 5;

    private const string DisabledReason = "skipped: disabled";
    private const string ExpiredReason = "expired";
    private const string NoProgramReason = "skipped: no active program";

    [Function(nameof(ReminderWorker))]
    public async Task Run(
        [QueueTrigger(StorageReminderQueue.QueueName)] QueueMessage message,
        CancellationToken cancellationToken)
    {
        var deliveryId = DeliveryIdFrom(message);

        try
        {
            await ProcessAsync(deliveryId, cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // Backoff is applied here rather than inside ProcessAsync so the send logic stays
            // free of transport concerns — and so it runs on the way out, after the row is
            // already marked 'failed' and before the throw hands control back to the host.
            await ApplyRetryBackoffAsync(message, deliveryId, cancellationToken);
            throw;
        }
    }

    /// <summary>
    /// Pushes this message's next visibility out per notifications.md's 1/5/15/60 schedule.
    /// </summary>
    // Deliberately skipped on the final dequeue: updating a message rewrites its pop receipt,
    // and the host needs the receipt it holds to move the message to reminders-poison. There
    // is nothing to back off before anyway — the next stop is the poison queue, not a retry.
    public async Task ApplyRetryBackoffAsync(
        QueueMessage message, Guid deliveryId, CancellationToken cancellationToken)
    {
        if (message.DequeueCount >= MaxDequeueCount)
        {
            logger.LogWarning(
                "Reminder delivery {DeliveryId} failed on its final attempt ({DequeueCount}); "
                + "leaving the message for the poison queue",
                deliveryId, message.DequeueCount);
            return;
        }

        var backoff = BackoffFor(message.DequeueCount);

        try
        {
            await queue.DelayRetryAsync(message.MessageId, message.PopReceipt, backoff, cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // The retry itself does not depend on this call: failing to extend the invisibility
            // window only means the message comes back sooner than the schedule wanted. Never
            // let it mask the provider failure that is about to be rethrown.
            logger.LogWarning(
                exception,
                "Could not set retry backoff for delivery {DeliveryId}; the platform's own timeout applies",
                deliveryId);
        }
    }

    /// <summary>Backoff for a message on its <paramref name="dequeueCount"/>-th delivery (1-based).</summary>
    public static TimeSpan BackoffFor(long dequeueCount)
        => RetryBackoff[(int)Math.Clamp(dequeueCount - 1, 0, RetryBackoff.Length - 1)];

    // The body is JSON written by StorageReminderQueue; TryParse also accepts the base64 form
    // in case the host's decoding and the sender's encoding ever disagree. A body that is
    // neither throws, which is the right outcome: it retries, then poisons, and the poison
    // handler logs it — nothing silently disappears.
    private static Guid DeliveryIdFrom(QueueMessage message)
    {
        var parsed = ReminderMessage.TryParse(message.Body.ToString())
            ?? throw new InvalidOperationException(
                $"Queue message {message.MessageId} is not a reminder pointer; body was not readable JSON.");

        return parsed.DeliveryId;
    }

    public async Task<ReminderOutcome> ProcessAsync(Guid deliveryId, CancellationToken cancellationToken = default)
    {
        var target = await db.DeliveryToSend(deliveryId).FirstOrDefaultAsync(cancellationToken);

        if (target is null)
        {
            // Nothing to send and nothing to retry into existence. Ack, or the message
            // redelivers five times on its way to the poison queue for no reason.
            logger.LogWarning("Reminder message for unknown delivery {DeliveryId}; discarding", deliveryId);
            return ReminderOutcome.NotFound;
        }

        var delivery = target.Delivery;

        // Idempotent consumption: at-least-once means a message for an already-sent row is
        // expected traffic, not an anomaly. 'failed' is included because that is precisely
        // the state a redelivery exists to retry.
        if (delivery.Status is not (DeliveryStatuses.Pending or DeliveryStatuses.Failed))
        {
            logger.LogInformation(
                "Reminder delivery {DeliveryId} already in status {Status}; acking",
                delivery.Id, delivery.Status);
            return ReminderOutcome.AlreadyHandled;
        }

        // The send-time guard. The scheduler read these flags up to 30 minutes ago; a client
        // deactivated or a schedule paused since then must not receive email, and this is the
        // last moment anyone can tell.
        if (!target.RecipientIsActive || !target.ScheduleEnabled)
        {
            return await MarkDeadAsync(delivery, DisabledReason, ReminderOutcome.SkippedDisabled, cancellationToken);
        }

        if ((clock.GetUtcNow() - delivery.ScheduledFor) > StaleAfter)
        {
            return await MarkDeadAsync(delivery, ExpiredReason, ReminderOutcome.Expired, cancellationToken);
        }

        var email = await RenderAsync(delivery.UserId, target.RecipientEmail, cancellationToken);
        if (email is null)
        {
            // A schedule with no program behind it has nothing to remind anyone about. Dead
            // rather than sent: an empty "Today:" line is worse than silence, and the row
            // says why without anyone having to reconstruct it.
            return await MarkDeadAsync(delivery, NoProgramReason, ReminderOutcome.NoActiveProgram, cancellationToken);
        }

        // Counted here and persisted with the outcome below — one write, immediately after
        // the provider answers. A hard crash mid-send leaves the attempt uncounted; that is
        // the same window that makes this at-least-once, not a separate defect.
        delivery.Attempts++;

        try
        {
            await sender.SendAsync(email, cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            delivery.Status = DeliveryStatuses.Failed;
            delivery.LastError = exception.Message;
            await db.SaveChangesAsync(cancellationToken);

            logger.LogError(
                exception,
                "Reminder delivery {DeliveryId} (schedule {ScheduleId}) failed on attempt {Attempt}",
                delivery.Id, delivery.ScheduleId, delivery.Attempts);

            // Rethrow so the platform's visibility timeout and dequeue count own the retry.
            // An in-process retry loop would hold the message invisible and turn a provider
            // outage into a function timeout (notifications.md §Retry).
            throw;
        }

        delivery.Status = DeliveryStatuses.Sent;
        delivery.SentAt = clock.GetUtcNow();
        // last_error is left as it was: this table is the audit log, and "sent on attempt 2
        // after "429 rate limited"" is the more useful record.
        await db.SaveChangesAsync(cancellationToken);

        logger.LogInformation(
            "Reminder delivery {DeliveryId} (schedule {ScheduleId}) sent on attempt {Attempt}",
            delivery.Id, delivery.ScheduleId, delivery.Attempts);

        return ReminderOutcome.Sent;
    }

    // notifications.md §Email content: rendered at send time from current program data, which
    // is what thin messages buy — a program edited after scheduling still mails correctly.
    // Scoped by client through ProgramsForClient, so the worker reads the recipient's own
    // program by construction rather than by care.
    //
    // Resolved for #38: the line names the active program, not a program day. program_days
    // carry only a position, nothing maps one to a calendar date, and inventing a rotation
    // rule here would have pre-empted the Today screen's own answer.
    private async Task<EmailMessage?> RenderAsync(Guid clientId, string recipient, CancellationToken cancellationToken)
    {
        var program = await db.ProgramsForClient(clientId)
            .Where(p => p.Status == ProgramStatuses.Active)
            .Select(p => new { p.Title, ExerciseCount = p.Days.SelectMany(d => d.Exercises).Count() })
            .AsNoTracking()
            .FirstOrDefaultAsync(cancellationToken);

        if (program is null)
        {
            return null;
        }

        var exercises = program.ExerciseCount == 1 ? "exercise" : "exercises";

        return new EmailMessage(
            recipient,
            $"Today: {program.Title}",
            $"Today: {program.Title} — {program.ExerciseCount} {exercises}."
            + $"\nOpen TrainerOS → {appBaseUrl.Value.TrimEnd('/')}");
    }

    private async Task<ReminderOutcome> MarkDeadAsync(
        NotificationDelivery delivery, string reason, ReminderOutcome outcome, CancellationToken cancellationToken)
    {
        delivery.Status = DeliveryStatuses.Dead;
        delivery.LastError = reason;
        await db.SaveChangesAsync(cancellationToken);

        logger.LogInformation(
            "Reminder delivery {DeliveryId} (schedule {ScheduleId}) marked dead: {Reason}",
            delivery.Id, delivery.ScheduleId, reason);

        return outcome;
    }
}
