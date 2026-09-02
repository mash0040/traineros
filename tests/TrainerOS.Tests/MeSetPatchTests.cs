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

    /// A's second exercise. Renumbering is per-exercise, so proving that needs two in one session.
    public Guid ExerciseA_OtherId { get; } = Guid.NewGuid();
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
                Id = ExerciseA_OtherId, TrainerId = TrainerAId, Name = "Overhead Press",
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

    /// A run of consecutive sets numbered 1..count against one exercise, for the renumbering
    /// tests. Its own session so a test can count rows without other tests' sets in the way.
    public (Guid SessionId, List<Guid> SetIds) SeedRunForClientA(
        int count, DateTimeOffset loggedAt, Guid? exerciseId = null)
    {
        return WithDb(db =>
        {
            var sessionId = Guid.NewGuid();
            db.Add(new WorkoutSession
            {
                Id = sessionId, TrainerId = TrainerAId, ClientId = ClientAId,
                PerformedOn = DateOnly.FromDateTime(loggedAt.UtcDateTime), CreatedAt = loggedAt,
            });

            var ids = new List<Guid>();
            for (var number = 1; number <= count; number++)
            {
                var set = new LoggedSet
                {
                    Id = Guid.NewGuid(), SessionId = sessionId, ExerciseId = exerciseId ?? ExerciseAId,
                    SetNumber = number, WeightKg = 100m, Reps = number, LoggedAt = loggedAt,
                };
                db.Add(set);
                ids.Add(set.Id);
            }

            db.SaveChanges();
            return (sessionId, ids);
        });
    }

    public List<(Guid Id, int SetNumber, int Reps)> SetsIn(Guid sessionId, Guid exerciseId)
    {
        return WithDb(db => db.LoggedSetsForClient(ClientAId)
            .Where(s => s.SessionId == sessionId && s.ExerciseId == exerciseId)
            .OrderBy(s => s.SetNumber)
            .AsNoTracking()
            .Select(s => new ValueTuple<Guid, int, int>(s.Id, s.SetNumber, s.Reps))
            .ToList());
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

    [Fact]
    public async Task Patch_with_null_weight_clears_the_set_to_bodyweight()
    {
        // #145's own case. The seeded set is 100 kg; a client correcting it to bodyweight sends
        // weight_kg: null, and until now that request succeeded and changed nothing. The log
        // screen refused the edit itself and told her to delete and re-log it, which is the
        // workaround #107's editor was built to remove.
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new
        {
            weightKg = (decimal?)null,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.LoggedSetsForClient(_app.ClientAId).AsNoTracking().Single(s => s.Id == setId));
        // Null, emphatically not 0m. The first cut of Patch<T> derived "is this null" from the
        // value, which for a value type collapses an explicit null to default(T) — so clearing
        // a weight would have written 0 kg and looked like it worked.
        Assert.Null(persisted.WeightKg);
        Assert.Equal(8, persisted.Reps);
    }

    [Fact]
    public async Task Patch_omitting_weight_leaves_it_alone()
    {
        // The half that makes the clear above safe, and the distinction that did not exist
        // before #145: absent and explicit-null were one value by the time the handler saw them.
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new
        {
            reps = 6,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.LoggedSetsForClient(_app.ClientAId).AsNoTracking().Single(s => s.Id == setId));
        Assert.Equal(100m, persisted.WeightKg);
        Assert.Equal(6, persisted.Reps);
    }

    [Theory]
    [InlineData("set_number", "{\"setNumber\": null}")]
    [InlineData("reps", "{\"reps\": null}")]
    public async Task Patch_with_null_on_a_not_null_column_is_400(string field, string body)
    {
        // set_number and reps back NOT NULL columns, so null asks for something impossible.
        // Refused rather than silently ignored, which is what it was before #145 — and, before
        // Patch<T> tracked nullness explicitly, it would have written a 0 instead.
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.ClientAId);

        var request = Request(HttpMethod.Patch, $"/api/me/sets/{setId}", session);
        request.Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
        var response = await _app.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains(field, problem.GetProperty("error").GetProperty("message").GetString());

        var persisted = _app.WithDb(db =>
            db.LoggedSetsForClient(_app.ClientAId).AsNoTracking().Single(s => s.Id == setId));
        Assert.Equal(1, persisted.SetNumber);
        Assert.Equal(8, persisted.Reps);
    }

    [Theory]
    [InlineData(0, 5)]      // set_number zero
    [InlineData(-1, 5)]     // set_number negative
    [InlineData(2, 0)]      // reps zero
    [InlineData(2, -3)]     // reps negative
    public async Task Patch_rejects_out_of_range_fields_with_400(int setNumber, int reps)
    {
        // Rewritten by #145. The rows used to carry nulls in the fields they were not testing,
        // which was fine while null meant "leave alone" and is not now: a null set_number is
        // itself a 400, so half these rows would have passed for a reason other than the one
        // their comment names. Every field is now a real value and only the named one is bad.
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new
        {
            setNumber,
            reps,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Patch_rejects_a_negative_weight_with_400()
    {
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/me/sets/{setId}", session, new
        {
            weightKg = -1.0m,
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

    // -- DELETE /api/me/sets/:id (#105) --

    [Fact]
    public async Task Anonymous_delete_is_401()
    {
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Delete, $"/api/me/sets/{setId}", null));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Trainer_role_delete_is_404()
    {
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Delete, $"/api/me/sets/{setId}", session);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Client_deletes_own_set_same_day()
    {
        var setId = _app.SeedSetForClientA(FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Delete, $"/api/me/sets/{setId}", session);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.False(_app.WithDb(db => db.LoggedSetsForClient(_app.ClientAId).Any(s => s.Id == setId)));
    }

    [Fact]
    public async Task Client_A_deleting_client_Bs_set_is_404()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Delete, $"/api/me/sets/{_app.SetBId}", session);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.NotNull(_app.WithDb(db => db.Find<LoggedSet>(_app.SetBId)));
    }

    [Fact]
    public async Task Delete_nonexistent_id_is_404_indistinguishable()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var madeUp = await SendAsync(HttpMethod.Delete, $"/api/me/sets/{Guid.NewGuid()}", session);
        var crossClient = await SendAsync(HttpMethod.Delete, $"/api/me/sets/{_app.SetBId}", session);

        Assert.Equal(HttpStatusCode.NotFound, madeUp.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, crossClient.StatusCode);
        Assert.Equal(
            await madeUp.Content.ReadAsStringAsync(),
            await crossClient.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Delete_after_local_midnight_is_404_and_keeps_the_set()
    {
        var loggedAt = new DateTimeOffset(2026, 7, 21, 12, 0, 0, TimeSpan.Zero);
        var setId = _app.SeedSetForClientA(loggedAt);
        _app.Clock.Now = new DateTimeOffset(2026, 7, 22, 12, 0, 0, TimeSpan.Zero);

        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Delete, $"/api/me/sets/{setId}", session);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("not_found", body.GetProperty("error").GetProperty("code").GetString());
        Assert.True(_app.WithDb(db => db.LoggedSetsForClient(_app.ClientAId).Any(s => s.Id == setId)));
    }

    [Fact]
    public async Task Delete_window_is_client_local_not_utc()
    {
        // 22:00 UTC = 18:00 local; deleted at 03:00 UTC next day = 23:00 local the same day.
        // A UTC-day rule refuses this; the client-local rule must allow it.
        var setId = _app.SeedSetForClientA(new DateTimeOffset(2026, 7, 21, 22, 0, 0, TimeSpan.Zero));
        _app.Clock.Now = new DateTimeOffset(2026, 7, 22, 3, 0, 0, TimeSpan.Zero);

        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Delete, $"/api/me/sets/{setId}", session);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    // -- Renumbering --

    [Fact]
    public async Task Deleting_a_middle_set_closes_the_gap()
    {
        // The decision this endpoint turns on. Deleting the accidental duplicate that api.md
        // §Cross-cutting names must leave 1..n, not "set 1, set 3" — which reads as a lost set
        // rather than a corrected one, and misaligns the log screen's last-time strip.
        var (sessionId, ids) = _app.SeedRunForClientA(4, FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Delete, $"/api/me/sets/{ids[1]}", session);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var remaining = _app.SetsIn(sessionId, _app.ExerciseAId);
        Assert.Equal(new[] { 1, 2, 3 }, remaining.Select(s => s.SetNumber).ToArray());
        // Identity preserved, not just the numbering: sets 3 and 4 shifted down, they were not
        // rewritten into each other. Reps carry the original set's ordinal from the seed.
        Assert.Equal(new[] { ids[0], ids[2], ids[3] }, remaining.Select(s => s.Id).ToArray());
        Assert.Equal(new[] { 1, 3, 4 }, remaining.Select(s => s.Reps).ToArray());
    }

    [Fact]
    public async Task Deleting_the_last_set_renumbers_nothing()
    {
        var (sessionId, ids) = _app.SeedRunForClientA(3, FakeClock.BaseNow);
        var session = await _app.SignInAsync(_app.ClientAId);

        await SendAsync(HttpMethod.Delete, $"/api/me/sets/{ids[2]}", session);

        var remaining = _app.SetsIn(sessionId, _app.ExerciseAId);
        Assert.Equal(new[] { 1, 2 }, remaining.Select(s => s.SetNumber).ToArray());
        Assert.Equal(new[] { ids[0], ids[1] }, remaining.Select(s => s.Id).ToArray());
    }

    [Fact]
    public async Task Renumbering_does_not_touch_another_exercise_in_the_same_session()
    {
        // Set numbers are per-exercise. Deleting a squat set must leave the presses alone.
        var (sessionId, squatIds) = _app.SeedRunForClientA(3, FakeClock.BaseNow);
        _app.WithDb(db =>
        {
            for (var number = 1; number <= 3; number++)
            {
                db.Add(new LoggedSet
                {
                    Id = Guid.NewGuid(), SessionId = sessionId, ExerciseId = _app.ExerciseA_OtherId,
                    SetNumber = number, WeightKg = 50m, Reps = number, LoggedAt = FakeClock.BaseNow,
                });
            }
            db.SaveChanges();
        });

        var session = await _app.SignInAsync(_app.ClientAId);
        await SendAsync(HttpMethod.Delete, $"/api/me/sets/{squatIds[0]}", session);

        Assert.Equal(new[] { 1, 2 }, _app.SetsIn(sessionId, _app.ExerciseAId).Select(s => s.SetNumber).ToArray());
        Assert.Equal(
            new[] { 1, 2, 3 },
            _app.SetsIn(sessionId, _app.ExerciseA_OtherId).Select(s => s.SetNumber).ToArray());
    }

    [Fact]
    public async Task A_refused_delete_renumbers_nothing()
    {
        // The shift happens after the row is gone and inside the same transaction, so a delete
        // that never happens must not leave the numbering rearranged behind it.
        var loggedAt = new DateTimeOffset(2026, 7, 21, 12, 0, 0, TimeSpan.Zero);
        var (sessionId, ids) = _app.SeedRunForClientA(3, loggedAt);
        _app.Clock.Now = new DateTimeOffset(2026, 7, 22, 12, 0, 0, TimeSpan.Zero);

        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Delete, $"/api/me/sets/{ids[0]}", session);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(new[] { 1, 2, 3 }, _app.SetsIn(sessionId, _app.ExerciseAId).Select(s => s.SetNumber).ToArray());
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
