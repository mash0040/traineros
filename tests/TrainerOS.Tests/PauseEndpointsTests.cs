using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
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

// api.md §Pause endpoints + notifications.md resolved question 2. The endpoints are
// unauthenticated by design — the signed token is the authorization — so these tests are
// where the two-step rule and the token's blast radius get pinned down.
public sealed class PauseTestApp : IAsyncLifetime
{
    private WebApplication _app = null!;
    private SqliteConnection _connection = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;
    public PauseTokenSigner Signer { get; } = new("pause-endpoint-tests-signing-key-32ch");

    public Guid TrainerId { get; } = Guid.NewGuid();
    public Guid ClientAId { get; } = Guid.NewGuid();
    public Guid ClientBId { get; } = Guid.NewGuid();
    public Guid ScheduleAId { get; } = Guid.NewGuid();
    public Guid ScheduleBId { get; } = Guid.NewGuid();

    public const string TestClientIpHeader = "X-Test-Client-IP";

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddApiConventions();
        builder.Services.AddDbContext<TrainerOsDbContext>(o => o.UseSqlite(_connection));
        builder.Services.AddSingleton<TimeProvider>(Clock);
        builder.Services.AddSingleton(Signer);
        builder.Services.AddAuthRateLimiting();

        _app = builder.Build();
        _app.UseApiErrorHandling();
        _app.Use((context, next) =>
        {
            if (context.Request.Headers.TryGetValue(TestClientIpHeader, out var ip))
            {
                context.Connection.RemoteIpAddress = IPAddress.Parse(ip.ToString());
            }

            return next(context);
        });
        _app.UseRateLimiter();
        _app.MapGroup("/api").MapPauseEndpoints();

        await _app.StartAsync();

        WithDb(db =>
        {
            db.Database.EnsureCreated();
            db.Add(new User
            {
                Id = TrainerId, Role = Roles.Trainer, Email = "trainer@example.com", DisplayName = "T",
                Timezone = "America/Toronto", IsActive = true, CreatedAt = Clock.Now,
            });
            SeedClientWithSchedule(db, ClientAId, ScheduleAId, "a");
            SeedClientWithSchedule(db, ClientBId, ScheduleBId, "b");
            return db.SaveChanges();
        });

        Client = _app.GetTestClient();
    }

    private void SeedClientWithSchedule(TrainerOsDbContext db, Guid clientId, Guid scheduleId, string tag)
    {
        db.Add(new User
        {
            Id = clientId, Role = Roles.Client, Email = $"client-{tag}@example.com", DisplayName = $"C{tag}",
            TrainerId = TrainerId, Timezone = "America/Toronto", IsActive = true, CreatedAt = Clock.Now,
        });
        db.Add(new NotificationSchedule
        {
            Id = scheduleId, TrainerId = TrainerId, ClientId = clientId, Kind = "workout_reminder",
            SendTime = new TimeOnly(7, 0), DaysOfWeek = [1, 2, 3, 4, 5], Enabled = true,
        });
    }

    public async Task DisposeAsync()
    {
        await _app.DisposeAsync();
        _connection.Dispose();
    }

    public T WithDb<T>(Func<TrainerOsDbContext, T> action)
    {
        using var scope = _app.Services.CreateScope();
        return action(scope.ServiceProvider.GetRequiredService<TrainerOsDbContext>());
    }

    public bool EnabledOf(Guid scheduleId)
        => WithDb(db => db.ScheduleForPause(scheduleId).AsNoTracking().Single().Enabled);

    public void ResetSchedules() => WithDb(db =>
        db.ScheduleForPause(ScheduleAId).ExecuteUpdate(s => s.SetProperty(x => x.Enabled, true))
        + db.ScheduleForPause(ScheduleBId).ExecuteUpdate(s => s.SetProperty(x => x.Enabled, true)));
}

public class PauseEndpointsTests : IClassFixture<PauseTestApp>
{
    private readonly PauseTestApp _app;
    private int _ipCounter;

    public PauseEndpointsTests(PauseTestApp app)
    {
        _app = app;
        _app.Clock.Now = FakeClock.BaseNow;
        _app.ResetSchedules();
    }

    // The rate limiter's budget is 10/IP/hour and the fixture is shared across this class,
    // so every test gets its own IP partition rather than racing for one bucket.
    private HttpRequestMessage Request(HttpMethod method, string url)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Add(PauseTestApp.TestClientIpHeader, $"10.0.0.{Interlocked.Increment(ref _ipCounter) % 250}");
        return request;
    }

    private Task<HttpResponseMessage> GetPause(string? token)
        => _app.Client.SendAsync(Request(HttpMethod.Get, $"/api/pause?token={token}"));

    private Task<HttpResponseMessage> PostPause(string? token)
    {
        var request = Request(HttpMethod.Post, "/api/pause");
        request.Content = JsonContent.Create(new { token });
        return _app.Client.SendAsync(request);
    }

    private static async Task<bool> ValidFlag(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("valid").GetBoolean();
    }

    private string TokenFor(Guid scheduleId) => _app.Signer.Issue(scheduleId, FakeClock.BaseNow);

    [Fact]
    public async Task Get_validates_without_pausing_anything()
    {
        // The mail-scanner scenario, which is the entire reason this is two steps: the link
        // is prefetched (twice, even) before the client ever opens the message.
        var token = TokenFor(_app.ScheduleAId);

        var first = await GetPause(token);
        var second = await GetPause(token);

        Assert.True(await ValidFlag(first));
        Assert.True(await ValidFlag(second));
        Assert.True(_app.EnabledOf(_app.ScheduleAId));

        // And the token survives the prefetches — the client's actual press still works.
        Assert.Equal(HttpStatusCode.OK, (await PostPause(token)).StatusCode);
        Assert.False(_app.EnabledOf(_app.ScheduleAId));
    }

    [Fact]
    public async Task Post_pauses_the_schedule_the_token_names()
    {
        var response = await PostPause(TokenFor(_app.ScheduleAId));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("ok").GetBoolean());
        Assert.False(_app.EnabledOf(_app.ScheduleAId));
        // Nobody else's reminders move.
        Assert.True(_app.EnabledOf(_app.ScheduleBId));
    }

    [Fact]
    public async Task Token_for_one_schedule_cannot_pause_another()
    {
        // The isolation test for a route with no session: swapping the schedule id inside
        // the token invalidates the signature, so client A's link is useless against B.
        var token = TokenFor(_app.ScheduleAId);
        var parts = token.Split('.');
        var forged = $"{_app.ScheduleBId:N}.{parts[1]}.{parts[2]}";

        var get = await GetPause(forged);
        var post = await PostPause(forged);

        Assert.False(await ValidFlag(get));
        Assert.Equal(HttpStatusCode.Unauthorized, post.StatusCode);
        Assert.True(_app.EnabledOf(_app.ScheduleBId));
        Assert.True(_app.EnabledOf(_app.ScheduleAId));
    }

    [Fact]
    public async Task Expired_token_is_rejected_on_both_verbs()
    {
        var token = TokenFor(_app.ScheduleAId);
        _app.Clock.Now = FakeClock.BaseNow + PauseTokenSigner.Lifetime + TimeSpan.FromMinutes(1);

        var get = await GetPause(token);
        var post = await PostPause(token);

        Assert.False(await ValidFlag(get));
        Assert.Equal(HttpStatusCode.Unauthorized, post.StatusCode);
        Assert.True(_app.EnabledOf(_app.ScheduleAId));
    }

    [Theory]
    [InlineData("")]
    [InlineData("garbage")]
    [InlineData("not.a.token")]
    public async Task Malformed_tokens_are_rejected_indistinguishably(string token)
    {
        var get = await GetPause(token);
        var post = await PostPause(token);

        Assert.False(await ValidFlag(get));
        Assert.Equal(HttpStatusCode.Unauthorized, post.StatusCode);
        var error = await post.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid_token", error.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Well_signed_token_for_a_deleted_schedule_looks_exactly_like_a_bad_one()
    {
        // No existence oracle: a valid signature over an id that no longer resolves gets the
        // same answer as a forgery.
        var token = TokenFor(Guid.NewGuid());

        var get = await GetPause(token);
        var post = await PostPause(token);

        Assert.False(await ValidFlag(get));
        Assert.Equal(HttpStatusCode.Unauthorized, post.StatusCode);
    }

    [Fact]
    public async Task Pausing_twice_is_a_no_op_not_an_error()
    {
        var token = TokenFor(_app.ScheduleAId);

        Assert.Equal(HttpStatusCode.OK, (await PostPause(token)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await PostPause(token)).StatusCode);
        Assert.False(_app.EnabledOf(_app.ScheduleAId));
    }

    [Fact]
    public async Task Both_verbs_are_rate_limited()
    {
        // api.md §Cross-cutting: pause inherits the auth endpoints' 10/IP/hour policy. One
        // fixed IP here, unlike the other tests, so the budget actually runs out.
        var token = TokenFor(_app.ScheduleAId);
        var responses = new List<HttpStatusCode>();

        for (var i = 0; i < 12; i++)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, $"/api/pause?token={token}");
            request.Headers.Add(PauseTestApp.TestClientIpHeader, "203.0.113.9");
            responses.Add((await _app.Client.SendAsync(request)).StatusCode);
        }

        Assert.Contains(HttpStatusCode.TooManyRequests, responses);

        var post = new HttpRequestMessage(HttpMethod.Post, "/api/pause")
        {
            Content = JsonContent.Create(new { token }),
        };
        post.Headers.Add(PauseTestApp.TestClientIpHeader, "203.0.113.9");
        Assert.Equal(HttpStatusCode.TooManyRequests, (await _app.Client.SendAsync(post)).StatusCode);
    }
}

public class PauseTokenSignerTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 25, 12, 0, 0, TimeSpan.Zero);
    private static readonly PauseTokenSigner Signer = new("pause-token-unit-tests-signing-key-32");

    [Fact]
    public void Round_trips_the_schedule_id()
    {
        var scheduleId = Guid.NewGuid();

        Assert.Equal(scheduleId, Signer.Validate(Signer.Issue(scheduleId, Now), Now));
    }

    [Fact]
    public void Token_is_url_safe()
    {
        var token = Signer.Issue(Guid.NewGuid(), Now);

        Assert.Equal(token, Uri.EscapeDataString(token).Replace("%2E", "."));
        Assert.DoesNotContain('+', token);
        Assert.DoesNotContain('/', token);
        Assert.DoesNotContain('=', token);
    }

    [Fact]
    public void Expiry_is_inside_the_signature_so_it_cannot_be_extended()
    {
        var scheduleId = Guid.NewGuid();
        var parts = Signer.Issue(scheduleId, Now).Split('.');
        var stretched = $"{parts[0]}.{DateTimeOffset.MaxValue.ToUnixTimeSeconds()}.{parts[2]}";

        Assert.Null(Signer.Validate(stretched, Now));
    }

    [Fact]
    public void Token_signed_with_another_key_does_not_validate()
    {
        var other = new PauseTokenSigner("a-completely-different-signing-key-32");

        Assert.Null(Signer.Validate(other.Issue(Guid.NewGuid(), Now), Now));
    }

    [Fact]
    public void Expires_exactly_at_its_lifetime()
    {
        var token = Signer.Issue(Guid.NewGuid(), Now);

        Assert.NotNull(Signer.Validate(token, Now + PauseTokenSigner.Lifetime - TimeSpan.FromSeconds(1)));
        Assert.Null(Signer.Validate(token, Now + PauseTokenSigner.Lifetime + TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public void Weak_signing_key_is_refused_at_construction()
        => Assert.Throws<ArgumentException>(() => new PauseTokenSigner("too-short"));
}
