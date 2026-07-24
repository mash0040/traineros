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

// PATCH /me/sets/:id has two axes to test: nested ownership (LoggedSetsForClient
// join through workout_sessions) and the client-local same-day window. Client A is
// in America/Toronto (UTC-4 in July); client B is the isolation target; the seeded
// sets have known LoggedAt values so each test can set the FakeClock to a specific
// local time and control whether "today" matches "logged day."
public sealed class MeSetPatchTestApp : IAsyncLifetime
{
    private readonly string _connectionString =
        $"Data Source=me-set-patch-tests-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";

    private WebApplication _app = null!;
    private SqliteConnection _keepAlive = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;

    public Guid TrainerAId { get; } = Guid.NewGuid();
    public Guid TrainerBId { get; } = Guid.NewGuid();
    public Guid ClientAId { get; } = Guid.NewGuid();
    public Guid ClientBId { get; } = Guid.NewGuid();

    public Guid ExerciseAId { get; } = Guid.NewGuid();
    public Guid ExerciseBId { get; } = Guid.NewGuid();

    public Guid SessionAId { get; } = Guid.NewGuid();
    public Guid SessionBId { get; } = Guid.NewGuid();

    // Client B's set — the cross-client isolation target.
    public Guid SetBId { get; } = Guid.NewGuid();

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

            db.Add(new Exercise
            {
                Id = ExerciseAId, TrainerId = TrainerAId, Name = "Squat",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseBId, TrainerId = TrainerBId, Name = "B's Deadlift",
                IsActive = true, CreatedAt = Clock.Now,
            });

            db.Add(new WorkoutSession
            {
                Id = SessionAId, TrainerId = TrainerAId, ClientId = ClientAId,
                PerformedOn = new DateOnly(2026, 7, 21), CreatedAt = Clock.Now,
            });
            db.Add(new WorkoutSession
            {
                Id = SessionBId, TrainerId = TrainerBId, ClientId = ClientBId,
                PerformedOn = new DateOnly(2026, 7, 21), CreatedAt = Clock.Now,
            });
            db.Add(new LoggedSet
            {
                Id = SetBId, SessionId = SessionBId, ExerciseId = ExerciseBId,
                SetNumber = 1, WeightKg = 100m, Reps = 5, LoggedAt = Clock.Now,
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

    // Seeds a fresh LoggedSet against client A's session with a caller-chosen
    // LoggedAt — same-day tests need control over the log timestamp independent
    // of the FakeClock's current value.
    public Guid SeedSetForClientA(DateTimeOffset loggedAt)
    {
        return WithDb(db =>
        {
            var set = new LoggedSet
            {
                Id = Guid.NewGuid(), SessionId = SessionAId, ExerciseId = ExerciseAId,
                SetNumber = 1, WeightKg = 100m, Reps = 8, LoggedAt = loggedAt,
            };
            db.Add(set);
            db.SaveChanges();
            return set.Id;
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

public class MeSetPatchTests : IClassFixture<MeSetPatchTestApp>
{
    private readonly MeSetPatchTestApp _app;

    public MeSetPatchTests(MeSetPatchTestApp app)
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

    // -- Role gating --

    [Fact]
    public async Task Anonymous_patch_is_401()
    {
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var request = Request(HttpMethod.Patch, $"/api/me/sets/{setId}", null);
        request.Content = JsonContent.Create(new { reps = 10 });
        var response = await _app.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Trainer_role_patch_is_404()
    {
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new { reps = 10 });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- Happy path --

    [Fact]
    public async Task Client_patches_own_set_same_day_updates_fields()
    {
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new
        {
            setNumber = 3,
            weightKg = 102.5m,
            reps = 10,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.LoggedSetsForClient(_app.ClientAId).AsNoTracking().Single(s => s.Id == setId));
        Assert.Equal(3, persisted.SetNumber);
        Assert.Equal(102.5m, persisted.WeightKg);
        Assert.Equal(10, persisted.Reps);
    }

    [Fact]
    public async Task Patch_leaves_untouched_fields_alone()
    {
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new
        {
            reps = 12,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.LoggedSetsForClient(_app.ClientAId).AsNoTracking().Single(s => s.Id == setId));
        Assert.Equal(1, persisted.SetNumber);       // untouched from seed
        Assert.Equal(100m, persisted.WeightKg);      // untouched from seed
        Assert.Equal(12, persisted.Reps);            // updated
    }

    [Theory]
    [InlineData(0, null, 5)]     // set_number zero
    [InlineData(-1, null, 5)]    // set_number negative
    [InlineData(null, null, 0)]  // reps zero
    [InlineData(null, null, -3)] // reps negative
    [InlineData(null, -1.0, 5)]  // weight negative
    public async Task Patch_rejects_invalid_fields_with_400(int? setNumber, double? weight, int? reps)
    {
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new
        {
            setNumber,
            weightKg = weight is null ? (decimal?)null : (decimal)weight.Value,
            reps,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // -- Nested ownership isolation (AC's marquee test) --

    [Fact]
    public async Task Client_A_patching_client_Bs_set_is_404()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{_app.SetBId}", session, new
        {
            reps = 99,
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        // B's set is untouched.
        var untouched = _app.WithDb(db => db.Find<LoggedSet>(_app.SetBId)!);
        Assert.Equal(5, untouched.Reps);
    }

    [Fact]
    public async Task Patch_nonexistent_id_is_404_indistinguishable()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var madeUp = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{Guid.NewGuid()}", session, new { reps = 5 });
        var crossClient = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{_app.SetBId}", session, new { reps = 5 });

        Assert.Equal(HttpStatusCode.NotFound, madeUp.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, crossClient.StatusCode);
        Assert.Equal(
            await madeUp.Content.ReadAsStringAsync(),
            await crossClient.Content.ReadAsStringAsync());
    }

    // -- Same-day window (client-local, not UTC) --

    [Fact]
    public async Task Patch_after_local_midnight_is_404_shape()
    {
        // Set logged at 2026-07-21 12:00 UTC (= 08:00 local America/Toronto, DST offset UTC-4).
        var loggedAt = new DateTimeOffset(2026, 7, 21, 12, 0, 0, TimeSpan.Zero);
        var setId = _app.SeedSetForClientA(loggedAt);

        // Move clock past local midnight into the next local day.
        _app.Clock.Now = new DateTimeOffset(2026, 7, 22, 12, 0, 0, TimeSpan.Zero);

        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new
        {
            reps = 6,
        });

        // Same shape as a not-found id — no timing oracle, no 403.
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("not_found", body.GetProperty("error").GetProperty("code").GetString());

        // Set was not mutated.
        var untouched = _app.WithDb(db =>
            db.LoggedSetsForClient(_app.ClientAId).AsNoTracking().Single(s => s.Id == setId));
        Assert.Equal(8, untouched.Reps);
    }

    // Boundary: log occurred at 23:30 local on day N; edit attempted at 23:45 local
    // same day — same local date, so still editable even though the UTC day rolled.
    [Fact]
    public async Task Patch_near_local_midnight_within_same_local_day_succeeds()
    {
        // 2026-07-22 03:30 UTC = 2026-07-21 23:30 America/Toronto (UTC-4 in July).
        var loggedAt = new DateTimeOffset(2026, 7, 22, 3, 30, 0, TimeSpan.Zero);
        var setId = _app.SeedSetForClientA(loggedAt);

        // 2026-07-22 03:45 UTC = 2026-07-21 23:45 local — same local date as loggedAt.
        _app.Clock.Now = new DateTimeOffset(2026, 7, 22, 3, 45, 0, TimeSpan.Zero);

        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new
        {
            reps = 9,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    // Boundary: log at 23:30 local; edit at 00:15 local next day — different local
    // date, so 404 even though UTC time is only 45 minutes later.
    [Fact]
    public async Task Patch_across_local_midnight_is_404()
    {
        var loggedAt = new DateTimeOffset(2026, 7, 22, 3, 30, 0, TimeSpan.Zero); // 23:30 local
        var setId = _app.SeedSetForClientA(loggedAt);

        // 2026-07-22 04:15 UTC = 2026-07-22 00:15 local (next local day).
        _app.Clock.Now = new DateTimeOffset(2026, 7, 22, 4, 15, 0, TimeSpan.Zero);

        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new
        {
            reps = 6,
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // Contrast: if the same-day rule used UTC instead of client local, the log at
    // 22:00 UTC and the edit at 03:00 UTC-next would be "different UTC days" and
    // rejected. In client local (UTC-4 America/Toronto), both are the same local
    // date, so the edit must succeed. This test would fail under a UTC-day rule.
    [Fact]
    public async Task Same_day_is_client_local_not_utc()
    {
        // 2026-07-21 22:00 UTC = 2026-07-21 18:00 local Toronto.
        var loggedAt = new DateTimeOffset(2026, 7, 21, 22, 0, 0, TimeSpan.Zero);
        var setId = _app.SeedSetForClientA(loggedAt);

        // 2026-07-22 03:00 UTC = 2026-07-21 23:00 local Toronto — still same local day.
        _app.Clock.Now = new DateTimeOffset(2026, 7, 22, 3, 0, 0, TimeSpan.Zero);

        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new
        {
            reps = 11,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
