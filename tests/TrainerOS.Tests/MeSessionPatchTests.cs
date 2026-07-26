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

namespace TrainerOS.Tests;

// PATCH /me/sessions/:id has the same two axes as the set patch it borrows from: ownership by
// join (WorkoutSessionsForClient) and a client-local same-day window. The difference worth
// testing is which timestamp the window reads — created_at, the entry event, not performed_on,
// which is when the workout happened. A retroactively logged session must stay editable.
//
// Both clients are in America/Toronto (UTC-4 in July) so a UTC-day rule and a local-day rule
// give visibly different answers on the boundary tests.
public sealed class MeSessionPatchTestApp : IAsyncLifetime
{
    private readonly string _connectionString =
        $"Data Source=me-session-patch-tests-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";

    private WebApplication _app = null!;
    private SqliteConnection _keepAlive = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;

    public Guid TrainerAId { get; } = Guid.NewGuid();
    public Guid TrainerBId { get; } = Guid.NewGuid();
    public Guid ClientAId { get; } = Guid.NewGuid();
    public Guid ClientBId { get; } = Guid.NewGuid();

    /// Client B's session — the cross-client isolation target.
    public Guid SessionBId { get; } = Guid.NewGuid();

    public async Task InitializeAsync()
    {
        _keepAlive = new SqliteConnection(_connectionString);
        _keepAlive.Open();

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddApiConventions();
        builder.Services.AddDbContext<TrainerOsDbContext>(o => o.UseSqlite(_connectionString));
        builder.Services.AddSingleton<TimeProvider>(Clock);
        builder.Services.AddScoped<SessionService>();

        _app = builder.Build();
        _app.UseApiErrorHandling();
        _app.UseMiddleware<SessionAuthMiddleware>();
        _app.MapGroup("/api").MapMeSessionEndpoints();

        await _app.StartAsync();

        SeedTenants();

        Client = _app.GetTestClient();
    }

    public async Task DisposeAsync()
    {
        await _app.DisposeAsync();
        _keepAlive.Dispose();
    }

    private void SeedTenants()
    {
        WithDb(db =>
        {
            db.Database.EnsureCreated();

            db.Add(new User
            {
                Id = TrainerAId, Role = Roles.Trainer, Email = "trainer-a@example.com",
                DisplayName = "Trainer A", Timezone = "America/Toronto", IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = TrainerBId, Role = Roles.Trainer, Email = "trainer-b@example.com",
                DisplayName = "Trainer B", Timezone = "America/Toronto", IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = ClientAId, Role = Roles.Client, Email = "alice@example.com",
                DisplayName = "Alice", TrainerId = TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = ClientBId, Role = Roles.Client, Email = "carol@example.com",
                DisplayName = "Carol", TrainerId = TrainerBId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });

            db.Add(new WorkoutSession
            {
                Id = SessionBId, TrainerId = TrainerBId, ClientId = ClientBId,
                PerformedOn = new DateOnly(2026, 7, 21), Comment = "B's note.", CreatedAt = Clock.Now,
            });

            db.SaveChanges();
        });
    }

    public async Task<Guid> SignInAsync(Guid userId)
    {
        using var scope = _app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TrainerOsDbContext>();
        var service = scope.ServiceProvider.GetRequiredService<SessionService>();

        var user = db.Find<User>(userId)!;
        var context = new DefaultHttpContext();
        var session = await service.SignInAsync(context, user);
        return session.Id;
    }

    // CreatedAt and PerformedOn are seeded independently so a test can separate "when the
    // workout happened" from "when it was entered" — the whole point of the window's choice.
    public Guid SeedSessionForClientA(
        DateTimeOffset createdAt, DateOnly? performedOn = null, string? comment = null)
    {
        return WithDb(db =>
        {
            var session = new WorkoutSession
            {
                Id = Guid.NewGuid(),
                TrainerId = TrainerAId,
                ClientId = ClientAId,
                PerformedOn = performedOn ?? DateOnly.FromDateTime(createdAt.UtcDateTime),
                Comment = comment,
                CreatedAt = createdAt,
            };
            db.Add(session);
            db.SaveChanges();
            return session.Id;
        });
    }

    public void WithDb(Action<TrainerOsDbContext> action) => WithDb(db =>
    {
        action(db);
        return 0;
    });

    public T WithDb<T>(Func<TrainerOsDbContext, T> action)
    {
        using var scope = _app.Services.CreateScope();
        return action(scope.ServiceProvider.GetRequiredService<TrainerOsDbContext>());
    }
}

public class MeSessionPatchTests : IClassFixture<MeSessionPatchTestApp>
{
    private readonly MeSessionPatchTestApp _app;

    public MeSessionPatchTests(MeSessionPatchTestApp app)
    {
        _app = app;
        _app.Clock.Now = FakeClock.BaseNow;
    }

    private HttpRequestMessage Request(HttpMethod method, string path, Guid? sessionId)
    {
        var request = new HttpRequestMessage(method, path);
        if (sessionId is not null)
        {
            request.Headers.Add("Cookie", $"{SessionCookie.Name}={sessionId}");
        }

        return request;
    }

    private async Task<HttpResponseMessage> SendAsync(
        HttpMethod method, string path, Guid sessionId, object? body = null)
    {
        var request = Request(method, path, sessionId);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await _app.Client.SendAsync(request);
    }

    // Find, not a DbSet: the owned-entity sets are internal on purpose and the tripwire test
    // keeps them that way. Each WithDb call gets its own scope, so nothing is served from a
    // change tracker the request already populated.
    private WorkoutSession Reload(Guid id) => _app.WithDb(db => db.Find<WorkoutSession>(id)!);

    // -- Role gating --

    [Fact]
    public async Task Anonymous_patch_is_401()
    {
        var sessionRow = _app.SeedSessionForClientA(FakeClock.BaseNow);
        var request = Request(HttpMethod.Patch, $"/api/me/sessions/{sessionRow}", null);
        request.Content = JsonContent.Create(new { comment = "hi" });
        var response = await _app.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Trainer_role_patch_is_404()
    {
        // /api/me/* is client-only. A trainer holds a valid session and still gets 404 — no
        // session, 401; wrong role, 404.
        var sessionRow = _app.SeedSessionForClientA(FakeClock.BaseNow);
        var auth = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sessions/{sessionRow}", auth, new
        {
            comment = "trainer wrote this",
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- Happy path --

    [Fact]
    public async Task Client_patches_own_session_same_day_updates_comment()
    {
        var sessionRow = _app.SeedSessionForClientA(FakeClock.BaseNow);
        var auth = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sessions/{sessionRow}", auth, new
        {
            comment = "Shoulder tweaked on OHP.",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Shoulder tweaked on OHP.", Reload(sessionRow).Comment);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Shoulder tweaked on OHP.", body.GetProperty("comment").GetString());
    }

    [Fact]
    public async Task Patch_overwrites_an_existing_comment()
    {
        var sessionRow = _app.SeedSessionForClientA(FakeClock.BaseNow, comment: "First pass.");
        var auth = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sessions/{sessionRow}", auth, new
        {
            comment = "Actually it was the left side.",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Actually it was the left side.", Reload(sessionRow).Comment);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task Patch_with_no_content_clears_the_comment(string? comment)
    {
        // Deliberate divergence from PATCH /me/sets/:id, where null means "leave this field
        // alone". With one field in the body that reading makes the request a no-op and leaves
        // no way to take a note back, so the body is the new value. Blank normalises to NULL
        // rather than being stored, matching POST.
        var sessionRow = _app.SeedSessionForClientA(FakeClock.BaseNow, comment: "Written by mistake.");
        var auth = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sessions/{sessionRow}", auth, new { comment });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null(Reload(sessionRow).Comment);
    }

    [Fact]
    public async Task Patch_refuses_a_body_that_tries_to_move_the_session()
    {
        // performed_on and program_day_id are what the session *is*; moving either would make
        // it a different session rather than an edited one. The request is refused outright
        // rather than silently narrowed to the comment — api.md §Cross-cutting rejects unknown
        // fields instead of ignoring them, precisely so a client bug surfaces as a 400 rather
        // than as a write that quietly did less than it asked for.
        var performedOn = new DateOnly(2026, 7, 19);
        var sessionRow = _app.SeedSessionForClientA(FakeClock.BaseNow, performedOn: performedOn);
        var auth = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sessions/{sessionRow}", auth, new
        {
            comment = "Fine.",
            performedOn = new DateOnly(2026, 1, 1),
            programDayId = Guid.NewGuid(),
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        // Nothing moved, and the comment was not written either — the body was rejected whole.
        var persisted = Reload(sessionRow);
        Assert.Equal(performedOn, persisted.PerformedOn);
        Assert.Null(persisted.ProgramDayId);
        Assert.Null(persisted.Comment);
    }

    // -- Ownership isolation (mandatory per conventions.md / api.md §5) --

    [Fact]
    public async Task Client_A_patching_client_Bs_session_is_404()
    {
        var auth = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sessions/{_app.SessionBId}", auth, new
        {
            comment = "written into someone else's history",
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("B's note.", Reload(_app.SessionBId).Comment);
    }

    [Fact]
    public async Task Patch_nonexistent_id_is_404_indistinguishable()
    {
        var auth = await _app.SignInAsync(_app.ClientAId);
        var madeUp = await SendAsync(
            HttpMethod.Patch, $"/api/me/sessions/{Guid.NewGuid()}", auth, new { comment = "x" });
        var crossClient = await SendAsync(
            HttpMethod.Patch, $"/api/me/sessions/{_app.SessionBId}", auth, new { comment = "x" });

        Assert.Equal(HttpStatusCode.NotFound, madeUp.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, crossClient.StatusCode);
        Assert.Equal(
            await madeUp.Content.ReadAsStringAsync(),
            await crossClient.Content.ReadAsStringAsync());
    }

    // -- Same-day window (client-local, measured on created_at) --

    [Fact]
    public async Task Patch_after_local_midnight_is_404_shape()
    {
        // Entered 2026-07-21 12:00 UTC = 08:00 local Toronto.
        var sessionRow = _app.SeedSessionForClientA(new DateTimeOffset(2026, 7, 21, 12, 0, 0, TimeSpan.Zero));
        _app.Clock.Now = new DateTimeOffset(2026, 7, 22, 12, 0, 0, TimeSpan.Zero);

        var auth = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sessions/{sessionRow}", auth, new
        {
            comment = "remembered something",
        });

        // Same shape as a not-found id — no 403, no timing oracle.
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("not_found", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Null(Reload(sessionRow).Comment);
    }

    [Fact]
    public async Task Window_is_measured_on_created_at_not_performed_on()
    {
        // The retroactive log: the workout happened four days ago, entered just now. Under a
        // performed_on rule this is long past the window and the client could never annotate a
        // session they just created. #32 settled the same question for sets — the window
        // governs the entry event.
        var sessionRow = _app.SeedSessionForClientA(
            createdAt: FakeClock.BaseNow, performedOn: DateOnly.FromDateTime(FakeClock.BaseNow.UtcDateTime).AddDays(-4));
        var auth = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sessions/{sessionRow}", auth, new
        {
            comment = "Catching up my log.",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Catching up my log.", Reload(sessionRow).Comment);
    }

    [Fact]
    public async Task Same_day_is_client_local_not_utc()
    {
        // Entered 2026-07-21 22:00 UTC = 18:00 local; edited 2026-07-22 03:00 UTC = 23:00 local
        // the same day. A UTC-day rule rejects this; a client-local rule must allow it. This is
        // the test that fails if the conversion is dropped.
        var sessionRow = _app.SeedSessionForClientA(new DateTimeOffset(2026, 7, 21, 22, 0, 0, TimeSpan.Zero));
        _app.Clock.Now = new DateTimeOffset(2026, 7, 22, 3, 0, 0, TimeSpan.Zero);

        var auth = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sessions/{sessionRow}", auth, new
        {
            comment = "Late but same day.",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Patch_across_local_midnight_is_404()
    {
        // Entered 23:30 local, edited 00:15 local the next day — 45 minutes apart in UTC, but a
        // different local date, so the window has closed.
        var sessionRow = _app.SeedSessionForClientA(new DateTimeOffset(2026, 7, 22, 3, 30, 0, TimeSpan.Zero));
        _app.Clock.Now = new DateTimeOffset(2026, 7, 22, 4, 15, 0, TimeSpan.Zero);

        var auth = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sessions/{sessionRow}", auth, new
        {
            comment = "one more thought",
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
