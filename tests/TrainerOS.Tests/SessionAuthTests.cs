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
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

namespace TrainerOS.Tests;

public sealed class FakeClock : TimeProvider
{
    public static readonly DateTimeOffset BaseNow = new(2026, 7, 21, 12, 0, 0, TimeSpan.Zero);

    public DateTimeOffset Now { get; set; } = BaseNow;

    public override DateTimeOffset GetUtcNow() => Now;
}

// Hosts the session middleware + role gates in a throwaway app with probe endpoints,
// mirroring ConventionsTestApp: the real protected routes arrive with later tickets.
public sealed class SessionAuthTestApp : IAsyncLifetime
{
    private WebApplication _app = null!;
    private SqliteConnection _connection = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;
    public Guid TrainerId { get; } = Guid.NewGuid();
    public Guid ClientId { get; } = Guid.NewGuid();
    public Guid InactiveClientId { get; } = Guid.NewGuid();

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddApiConventions();
        builder.Services.AddDbContext<TrainerOsDbContext>(o => o.UseSqlite(_connection));
        builder.Services.AddSingleton<TimeProvider>(Clock);
        builder.Services.AddScoped<SessionService>();

        _app = builder.Build();
        _app.UseApiErrorHandling();
        _app.UseMiddleware<SessionAuthMiddleware>();

        var api = _app.MapGroup("/api");

        var trainer = api.MapGroup("/t");
        trainer.RequireTrainer();
        trainer.MapGet("/whoami", (HttpContext http) => Results.Ok(new { Id = http.GetCurrentUser()!.Id }));

        var client = api.MapGroup("/c");
        client.RequireClient();
        client.MapGet("/whoami", (HttpContext http) => Results.Ok(new { Id = http.GetCurrentUser()!.Id }));
        client.MapPost("/whoami", (HttpContext http, ImposterBody body) =>
            Results.Ok(new { Id = http.GetCurrentUser()!.Id }));

        await _app.StartAsync();

        using (var scope = _app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<TrainerOsDbContext>();
            db.Database.EnsureCreated();
            db.Add(new User
            {
                Id = TrainerId, Role = Roles.Trainer, Email = "trainer@example.com",
                DisplayName = "T", Timezone = "America/Toronto", IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = ClientId, Role = Roles.Client, Email = "client@example.com",
                DisplayName = "C", TrainerId = TrainerId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = InactiveClientId, Role = Roles.Client, Email = "gone@example.com",
                DisplayName = "G", TrainerId = TrainerId, Timezone = "America/Toronto",
                IsActive = false, CreatedAt = Clock.Now,
            });
            db.SaveChanges();
        }

        Client = _app.GetTestClient();
    }

    public async Task DisposeAsync()
    {
        await _app.DisposeAsync();
        _connection.Dispose();
    }

    public sealed record ImposterBody(Guid? UserId);

    /// <summary>Creates a session via SessionService (as the login endpoints will) and returns it with the raw Set-Cookie header.</summary>
    public async Task<(Session Session, string SetCookie)> SignInAsync(Guid userId)
    {
        using var scope = _app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TrainerOsDbContext>();
        var service = scope.ServiceProvider.GetRequiredService<SessionService>();

        var user = db.Find<User>(userId)!;
        var httpContext = new DefaultHttpContext();
        var session = await service.SignInAsync(httpContext, user);

        return (session, httpContext.Response.Headers.SetCookie.ToString());
    }

    public T WithDb<T>(Func<TrainerOsDbContext, T> action)
    {
        using var scope = _app.Services.CreateScope();
        return action(scope.ServiceProvider.GetRequiredService<TrainerOsDbContext>());
    }

    public void Revoke(Guid sessionId) => WithDb(db =>
    {
        var session = db.Sessions.Single(s => s.Id == sessionId);
        session.RevokedAt = Clock.Now;
        return db.SaveChanges();
    });
}

public class SessionAuthTests : IClassFixture<SessionAuthTestApp>, IDisposable
{
    private readonly SessionAuthTestApp _app;

    public SessionAuthTests(SessionAuthTestApp app)
    {
        _app = app;
        _app.Clock.Now = FakeClock.BaseNow;
    }

    // The fixture is shared; tests that move the clock must not bleed into the next test.
    public void Dispose() => _app.Clock.Now = FakeClock.BaseNow;

    private HttpRequestMessage Request(HttpMethod method, string path, Guid? sessionId = null)
    {
        var request = new HttpRequestMessage(method, path);
        if (sessionId is not null)
        {
            request.Headers.Add("Cookie", $"{SessionCookie.Name}={sessionId}");
        }

        return request;
    }

    private static async Task AssertNotFoundShape(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("not_found", body.GetProperty("error").GetProperty("code").GetString());
    }

    // "Session gone → login" must be distinguishable from "resource not found" by the SPA:
    // anything without a live session is 401; only authenticated-but-wrong-role is 404.
    private static async Task AssertUnauthorizedShape(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("unauthorized", body.GetProperty("error").GetProperty("code").GetString());
    }

    // -- Session creation --

    [Fact]
    public async Task Login_creates_session_row_with_30_day_expiry_for_trainer()
    {
        var (session, _) = await _app.SignInAsync(_app.TrainerId);

        Assert.Equal(FakeClock.BaseNow + SessionService.TrainerLifetime, session.ExpiresAt);
        Assert.True(_app.WithDb(db => db.Sessions.Any(s => s.Id == session.Id && s.UserId == _app.TrainerId)));
    }

    [Fact]
    public async Task Login_creates_session_row_with_90_day_expiry_for_client()
    {
        var (session, _) = await _app.SignInAsync(_app.ClientId);

        Assert.Equal(FakeClock.BaseNow + SessionService.ClientLifetime, session.ExpiresAt);
    }

    [Fact]
    public async Task Session_cookie_is_opaque_httponly_secure_samesite_lax()
    {
        var (session, setCookie) = await _app.SignInAsync(_app.ClientId);

        Assert.StartsWith($"{SessionCookie.Name}={session.Id}", setCookie);
        Assert.Contains("httponly", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("secure", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=lax", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("path=/", setCookie, StringComparison.OrdinalIgnoreCase);
    }

    // -- Role gates --

    [Fact]
    public async Task Valid_session_passes_matching_gate_with_session_identity()
    {
        var (session, _) = await _app.SignInAsync(_app.TrainerId);

        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/t/whoami", session.Id));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(_app.TrainerId, body.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task Wrong_role_is_rejected_with_404_not_403()
    {
        var (session, _) = await _app.SignInAsync(_app.ClientId);

        await AssertNotFoundShape(await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/t/whoami", session.Id)));
    }

    [Fact]
    public async Task Anonymous_request_is_rejected_with_401()
    {
        await AssertUnauthorizedShape(await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/t/whoami")));
    }

    [Fact]
    public async Task Malformed_cookie_value_is_rejected_with_401()
    {
        var request = Request(HttpMethod.Get, "/api/c/whoami");
        request.Headers.Add("Cookie", $"{SessionCookie.Name}=not-a-guid");

        await AssertUnauthorizedShape(await _app.Client.SendAsync(request));
    }

    [Fact]
    public async Task Nonexistent_session_id_is_rejected_with_401()
    {
        await AssertUnauthorizedShape(
            await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/c/whoami", Guid.NewGuid())));
    }

    [Fact]
    public async Task Expired_session_is_rejected_with_401()
    {
        var (session, _) = await _app.SignInAsync(_app.TrainerId);
        _app.Clock.Now = FakeClock.BaseNow + SessionService.TrainerLifetime + TimeSpan.FromSeconds(1);

        await AssertUnauthorizedShape(await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/t/whoami", session.Id)));
    }

    [Fact]
    public async Task Revoked_session_is_rejected_with_401()
    {
        var (session, _) = await _app.SignInAsync(_app.TrainerId);
        _app.Revoke(session.Id);

        await AssertUnauthorizedShape(await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/t/whoami", session.Id)));
    }

    [Fact]
    public async Task Deactivated_users_session_is_rejected_with_401()
    {
        var (session, _) = await _app.SignInAsync(_app.InactiveClientId);

        await AssertUnauthorizedShape(await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/c/whoami", session.Id)));
    }

    // -- Identity source and GET purity --

    [Fact]
    public async Task Identity_comes_from_cookie_never_from_query_or_body()
    {
        var (session, _) = await _app.SignInAsync(_app.ClientId);

        var viaQuery = Request(HttpMethod.Get, $"/api/c/whoami?user_id={_app.TrainerId}", session.Id);
        var queryBody = await (await _app.Client.SendAsync(viaQuery)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(_app.ClientId, queryBody.GetProperty("id").GetGuid());

        var viaBody = Request(HttpMethod.Post, "/api/c/whoami", session.Id);
        viaBody.Content = JsonContent.Create(new { userId = _app.TrainerId });
        var bodyBody = await (await _app.Client.SendAsync(viaBody)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(_app.ClientId, bodyBody.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task Get_requests_change_no_session_state()
    {
        var (session, _) = await _app.SignInAsync(_app.TrainerId);
        var before = _app.WithDb(db => db.Sessions.AsNoTracking()
            .Select(s => new { s.Id, s.ExpiresAt, s.CreatedAt, s.RevokedAt }).OrderBy(s => s.Id).ToList());

        await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/t/whoami", session.Id));
        await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/t/whoami"));
        await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/c/whoami", session.Id));

        var after = _app.WithDb(db => db.Sessions.AsNoTracking()
            .Select(s => new { s.Id, s.ExpiresAt, s.CreatedAt, s.RevokedAt }).OrderBy(s => s.Id).ToList());
        Assert.Equal(before, after);
    }
}
