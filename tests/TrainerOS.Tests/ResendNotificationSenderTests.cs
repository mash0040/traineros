using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

using TrainerOS.Domain.Notifications;

namespace TrainerOS.Tests;

public class ResendNotificationSenderTests
{
    // Captures every outbound request so tests can assert URL, headers, and body
    // without hitting the real Resend API.
    private sealed class CapturingHandler(HttpStatusCode status, string responseBody = "{\"id\":\"stub\"}")
        : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; private set; }
        public string? LastBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            LastBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(status)
            {
                Content = new StringContent(responseBody),
            };
        }
    }

    private static ResendNotificationSender BuildSender(
        HttpMessageHandler handler, string apiKey = "re_test_key", string from = "noreply@trainer.example")
    {
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.resend.com/") };
        http.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
        var options = Options.Create(new ResendOptions { ApiKey = apiKey, From = from });
        return new ResendNotificationSender(http, options);
    }

    [Fact]
    public async Task Send_posts_to_emails_endpoint_with_bearer_token()
    {
        var handler = new CapturingHandler(HttpStatusCode.OK);
        var sender = BuildSender(handler, apiKey: "re_live_secret");

        await sender.SendAsync(new EmailMessage("client@example.com", "Today's workout", "Open TrainerOS →"));

        Assert.NotNull(handler.LastRequest);
        Assert.Equal(HttpMethod.Post, handler.LastRequest!.Method);
        Assert.Equal("https://api.resend.com/emails", handler.LastRequest.RequestUri!.ToString());
        Assert.Equal("Bearer", handler.LastRequest.Headers.Authorization!.Scheme);
        Assert.Equal("re_live_secret", handler.LastRequest.Headers.Authorization.Parameter);
    }

    [Fact]
    public async Task Send_serializes_from_to_subject_text_payload()
    {
        var handler = new CapturingHandler(HttpStatusCode.OK);
        var sender = BuildSender(handler, from: "reminders@trainer.example");

        await sender.SendAsync(new EmailMessage(
            "client@example.com",
            "Today: Push Day — 5 exercises",
            "Open TrainerOS → https://app/today"));

        Assert.NotNull(handler.LastBody);
        var payload = JsonDocument.Parse(handler.LastBody!).RootElement;

        // The wire keys are camelCase; the record is From/To/Subject/Text.
        Assert.Equal("reminders@trainer.example", payload.GetProperty("from").GetString());
        Assert.Equal("client@example.com", payload.GetProperty("to").GetString());
        Assert.Equal("Today: Push Day — 5 exercises", payload.GetProperty("subject").GetString());
        Assert.Equal("Open TrainerOS → https://app/today", payload.GetProperty("text").GetString());
    }

    [Fact]
    public async Task Send_throws_ResendSendException_on_non_success_with_status_and_body()
    {
        var handler = new CapturingHandler(HttpStatusCode.Unauthorized, "{\"message\":\"invalid api key\"}");
        var sender = BuildSender(handler);

        var ex = await Assert.ThrowsAsync<ResendSendException>(() =>
            sender.SendAsync(new EmailMessage("c@example.com", "s", "b")));

        Assert.Contains("401", ex.Message);
        Assert.Contains("invalid api key", ex.Message);
    }

    // -- Config binding / validation --

    [Fact]
    public void AddResendNotificationSender_registers_INotificationSender_as_Resend()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Resend:ApiKey"] = "re_valid",
            ["Resend:From"] = "noreply@trainer.example",
        }).Build();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddResendNotificationSender(config);

        using var provider = services.BuildServiceProvider();
        var sender = provider.GetRequiredService<INotificationSender>();

        Assert.IsType<ResendNotificationSender>(sender);
    }

    [Fact]
    public void Startup_fails_when_ApiKey_is_missing()
    {
        // ValidateOnStart surfaces missing config at provider build (mirrors the
        // Program.cs "refuse to start with email silently unwired" guard).
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Resend:From"] = "noreply@trainer.example",
        }).Build();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddResendNotificationSender(config);

        var ex = Assert.Throws<OptionsValidationException>(() =>
        {
            using var provider = services.BuildServiceProvider();
            _ = provider.GetRequiredService<IOptions<ResendOptions>>().Value;
        });

        Assert.Contains("Resend:ApiKey is required.", ex.Message);
    }

    [Fact]
    public void Startup_fails_when_From_is_missing()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Resend:ApiKey"] = "re_valid",
        }).Build();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddResendNotificationSender(config);

        var ex = Assert.Throws<OptionsValidationException>(() =>
        {
            using var provider = services.BuildServiceProvider();
            _ = provider.GetRequiredService<IOptions<ResendOptions>>().Value;
        });

        Assert.Contains("Resend:From is required.", ex.Message);
    }

    [Fact]
    public void Startup_fails_when_ApiKey_is_whitespace()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Resend:ApiKey"] = "   ",
            ["Resend:From"] = "noreply@trainer.example",
        }).Build();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddResendNotificationSender(config);

        Assert.Throws<OptionsValidationException>(() =>
        {
            using var provider = services.BuildServiceProvider();
            _ = provider.GetRequiredService<IOptions<ResendOptions>>().Value;
        });
    }
}
