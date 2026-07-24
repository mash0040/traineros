using System.Net.Http.Headers;
using System.Net.Http.Json;

using Microsoft.Extensions.Options;

using TrainerOS.Domain.Notifications;

namespace TrainerOS.Api.Notifications;

// Production INotificationSender. Posts to Resend's transactional email API
// (https://resend.com/docs/api-reference/emails/send-email). The adapter is one
// HTTP call per message — retries and idempotency live in the worker
// (notifications.md §Retry & dead-lettering); this class only serializes
// EmailMessage → provider payload and turns a non-2xx into an exception the
// caller can queue-retry.
//
// Idempotency-key header is a documented v1.1 hardening (notifications.md §71)
// and deliberately not added here — the worker's DB-enforced idempotency covers
// the systemic duplicate, and this adapter stays a thin transport.
public sealed class ResendNotificationSender : INotificationSender
{
    private readonly HttpClient _http;
    private readonly ResendOptions _options;

    public ResendNotificationSender(HttpClient http, IOptions<ResendOptions> options)
    {
        _http = http;
        _options = options.Value;
    }

    public async Task SendAsync(EmailMessage message, CancellationToken cancellationToken = default)
    {
        var payload = new ResendSendRequest(
            From: _options.From,
            To: message.To,
            Subject: message.Subject,
            Text: message.Body);

        using var response = await _http.PostAsJsonAsync("emails", payload, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new ResendSendException(
                $"Resend rejected the send request: {(int)response.StatusCode} {response.ReasonPhrase}. Body: {errorBody}");
        }
    }

    // Resend accepts `text` OR `html` (or both). We send plain-text only: v1 template
    // is one-liner "Today: {program_day.title} — {n} exercises. Open TrainerOS →"
    // (notifications.md §Email content). HTML rendering is deferred with the template
    // itself — a system.md concern, not this adapter's.
    private sealed record ResendSendRequest(string From, string To, string Subject, string Text);
}

// Distinct exception type so the worker's retry/dead-letter logic can distinguish
// "send failed" from "transport failed" if it ever needs to (v1 treats both the
// same, but the type keeps the seam sharp).
public sealed class ResendSendException(string message) : Exception(message);

public static class ResendNotificationSenderRegistration
{
    // Config-driven wiring. Both ApiKey and From are validated at startup: an empty
    // or missing value fails Program build, honoring the "refuse to start with email
    // silently unwired" guard in Program.cs.
    public static IServiceCollection AddResendNotificationSender(
        this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<ResendOptions>()
            .Bind(configuration.GetSection("Resend"))
            .Validate(o => !string.IsNullOrWhiteSpace(o.ApiKey), "Resend:ApiKey is required.")
            .Validate(o => !string.IsNullOrWhiteSpace(o.From), "Resend:From is required.")
            .ValidateOnStart();

        // Typed HttpClient — one client per DI resolution, configured with the base
        // URL and bearer token. IHttpClientFactory recycles the underlying handler
        // so we don't leak sockets on repeated resolution.
        services.AddHttpClient<INotificationSender, ResendNotificationSender>((sp, http) =>
        {
            var options = sp.GetRequiredService<IOptions<ResendOptions>>().Value;
            http.BaseAddress = new Uri("https://api.resend.com/");
            http.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", options.ApiKey);
        });

        return services;
    }
}
