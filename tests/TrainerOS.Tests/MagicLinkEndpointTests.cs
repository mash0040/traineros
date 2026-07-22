using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

using TrainerOS.Api;
using TrainerOS.Api.Auth;
using TrainerOS.Api.Endpoints;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;
using TrainerOS.Domain.Notifications;

namespace TrainerOS.Tests;

public sealed class RecordingSender : INotificationSender
{
    private readonly List<EmailMessage> _sent = [];

    public Task SendAsync(EmailMessage message, CancellationToken cancellationToken = default)
    {
        lock (_sent)
        {
            _sent.Add(message);
        }

        return Task.CompletedTask;
    }

    public List<EmailMessage> SentTo(string email)
    {
        lock (_sent)
        {
            return _sent.Where(m => m.To == email).ToList();
        }
    }
}

public sealed class MagicLinkTestApp : IAsyncLifetime
{
    // Shared-cache named in-memory DB: token issuance runs post-response on its own scope
    // (and thread), so each DbContext needs its own connection to the same database.
    // The name is per-instance because xunit runs test classes (each with its own
    // fixture) in parallel — a shared name would cross-contaminate.
    private readonly string _connectionString =
        $"Data Source=auth-tests-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";

    private WebApplication _app = null!;
    private SqliteConnection _keepAlive = null!;

    public FakeClock Clock { get; } = new();
    public RecordingSender Sender { get; } = new();
    public HttpClient Client { get; private set; } = null!;
    public Guid ClientUserId { get; } = Guid.NewGuid();
    public Guid TrainerUserId { get; } = Guid.NewGuid();

    public const string ClientEmail = "client@example.com";
    public const string InactiveEmail = "inactive@example.com";
    public const string TrainerEmail = "trainer@example.com";

    public async Task InitializeAsync()
    {
        _keepAlive = new SqliteConnection(_connectionString);
        _keepAlive.Open();

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration["App:BaseUrl"] = "http://localhost:5173/";
        builder.Services.AddApiConventions();
        builder.Services.AddDbContext<TrainerOsDbContext>(o => o.UseSqlite(_connectionString));
        builder.Services.AddSingleton<TimeProvider>(Clock);
        builder.Services.AddSingleton<INotificationSender>(Sender);
        builder.Services.AddScoped<SessionService>();

        _app = builder.Build();
        _app.UseApiErrorHandling();
        _app.MapGroup("/api").MapAuthEndpoints();

        await _app.StartAsync();

        var trainerId = TrainerUserId;
        WithDb(db =>
        {
            db.Database.EnsureCreated();
            db.Add(new User
            {
                Id = trainerId, Role = Roles.Trainer, Email = TrainerEmail,
                DisplayName = "T", Timezone = "America/Toronto", IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = ClientUserId, Role = Roles.Client, Email = ClientEmail,
                DisplayName = "C", TrainerId = trainerId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = Guid.NewGuid(), Role = Roles.Client, Email = InactiveEmail,
                DisplayName = "X", TrainerId = trainerId, Timezone = "America/Toronto",
                IsActive = false, CreatedAt = Clock.Now,
            });
            return db.SaveChanges();
        });

        Client = _app.GetTestClient();
    }

    public async Task DisposeAsync()
    {
        await _app.DisposeAsync();
        _keepAlive.Dispose();
    }

    public T WithDb<T>(Func<TrainerOsDbContext, T> action)
    {
        using var scope = _app.Services.CreateScope();
        return action(scope.ServiceProvider.GetRequiredService<TrainerOsDbContext>());
    }
}

public class MagicLinkEndpointTests : IClassFixture<MagicLinkTestApp>
{
    private readonly MagicLinkTestApp _app;

    public MagicLinkEndpointTests(MagicLinkTestApp app)
    {
        _app = app;
        _app.Clock.Now = FakeClock.BaseNow;
    }

    private Task<HttpResponseMessage> Post(string email)
        => _app.Client.PostAsJsonAsync("/api/auth/magic-link", new { email });

    private static async Task<bool> Eventually(Func<bool> condition, int timeoutMs = 3000)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            if (condition())
            {
                return true;
            }

            await Task.Delay(25);
        }

        return condition();
    }

    [Fact]
    public async Task Known_client_email_gets_hashed_token_row_and_email_with_raw_token()
    {
        var response = await Post(MagicLinkTestApp.ClientEmail);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.True(await Eventually(() => _app.Sender.SentTo(MagicLinkTestApp.ClientEmail).Count > 0),
            "expected a magic-link email to be sent");

        var message = Assert.Single(_app.Sender.SentTo(MagicLinkTestApp.ClientEmail));
        var match = Regex.Match(message.Body, @"token=([A-Za-z0-9_-]+)");
        Assert.True(match.Success, "email body must contain the raw token link");
        var rawToken = match.Groups[1].Value;
        Assert.Contains("http://localhost:5173/verify?token=", message.Body);

        var row = _app.WithDb(db => db.MagicLinkTokens.Single(t => t.UserId == _app.ClientUserId));
        Assert.Equal(MagicLinkTokens.Hash(rawToken), row.TokenHash);   // stored = SHA-256 of raw
        Assert.NotEqual(rawToken, row.TokenHash);                       // raw never stored
        Assert.DoesNotContain(row.TokenHash, message.Body);             // hash never mailed
        Assert.Equal(FakeClock.BaseNow + MagicLinkTokens.Lifetime, row.ExpiresAt);
        Assert.Null(row.UsedAt);                                        // single-use: consumed by #21
    }

    [Fact]
    public async Task Unknown_email_returns_identical_202_and_sends_nothing()
    {
        var known = await Post(MagicLinkTestApp.ClientEmail);
        var unknown = await Post("nobody@example.com");

        Assert.Equal(HttpStatusCode.Accepted, known.StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, unknown.StatusCode);
        Assert.Equal(await known.Content.ReadAsStringAsync(), await unknown.Content.ReadAsStringAsync());
        var body = await unknown.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("ok").GetBoolean());

        await Task.Delay(400); // grace period for any (wrong) background work to surface
        Assert.Empty(_app.Sender.SentTo("nobody@example.com"));
    }

    [Fact]
    public async Task Trainer_email_gets_a_magic_link_too()
    {
        // Doubles as the trainer's password recovery: v1 has no reset flow.
        var response = await Post(MagicLinkTestApp.TrainerEmail);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.True(await Eventually(() => _app.Sender.SentTo(MagicLinkTestApp.TrainerEmail).Count > 0),
            "expected a magic-link email for the trainer");

        var row = _app.WithDb(db => db.MagicLinkTokens.Single(t => t.UserId == _app.TrainerUserId));
        Assert.Null(row.UsedAt);
    }

    [Fact]
    public async Task Deactivated_client_email_is_treated_like_unknown()
    {
        var response = await Post(MagicLinkTestApp.InactiveEmail);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        await Task.Delay(400);
        Assert.Empty(_app.Sender.SentTo(MagicLinkTestApp.InactiveEmail));
    }

    [Fact]
    public async Task Blank_email_is_rejected_with_400()
    {
        var response = await Post("   ");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("bad_request", body.GetProperty("error").GetProperty("code").GetString());
    }
}
