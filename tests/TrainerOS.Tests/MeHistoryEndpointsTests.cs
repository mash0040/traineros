using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Web;

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

// Fixture builds a multi-session history for client A across two exercises (Squat
// and Bench), so cursor pagination and the exercise_id filter each have real data
// to page through. Client B has their own "SECRET" set that must never surface in
// A's responses regardless of what ids A passes as query params.
public sealed class MeHistoryEndpointsTestApp : IAsyncLifetime
{
    private readonly string _connectionString =
        $"Data Source=me-history-tests-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";

    private WebApplication _app = null!;
    private SqliteConnection _keepAlive = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;

    public Guid TrainerAId { get; } = Guid.NewGuid();
    public Guid TrainerBId { get; } = Guid.NewGuid();
    public Guid ClientAId { get; } = Guid.NewGuid();
    public Guid ClientBId { get; } = Guid.NewGuid();

    public Guid SquatId { get; } = Guid.NewGuid();
    public Guid BenchId { get; } = Guid.NewGuid();
    public Guid ExerciseBId { get; } = Guid.NewGuid();

    // Two of A's sessions on distinct dates so /last has to pick the newer one.
    public Guid SessionA_OlderId { get; } = Guid.NewGuid();
    public Guid SessionA_NewerId { get; } = Guid.NewGuid();
    public Guid SessionB_Id { get; } = Guid.NewGuid();

    // A's set ids across sessions (bench+squat mixed).
    public Guid SetA_Old_Squat1Id { get; } = Guid.NewGuid();
    public Guid SetA_Old_Squat2Id { get; } = Guid.NewGuid();
    public Guid SetA_Old_Bench1Id { get; } = Guid.NewGuid();
    public Guid SetA_New_Squat1Id { get; } = Guid.NewGuid();
    public Guid SetA_New_Squat2Id { get; } = Guid.NewGuid();
    public Guid SetA_New_Squat3Id { get; } = Guid.NewGuid();
    public Guid SetB_SecretId { get; } = Guid.NewGuid();

    // Timestamps in strict ascending order. Every /history response for A must
    // list sets in strict logged_at DESC — the pagination invariant.
    public DateTimeOffset T1 { get; } = new(2026, 7, 15, 10, 0, 0, TimeSpan.Zero);
    public DateTimeOffset T2 { get; } = new(2026, 7, 15, 10, 3, 0, TimeSpan.Zero);
    public DateTimeOffset T3 { get; } = new(2026, 7, 15, 10, 6, 0, TimeSpan.Zero);
    public DateTimeOffset T4 { get; } = new(2026, 7, 20, 9, 0, 0, TimeSpan.Zero);
    public DateTimeOffset T5 { get; } = new(2026, 7, 20, 9, 4, 0, TimeSpan.Zero);
    public DateTimeOffset T6 { get; } = new(2026, 7, 20, 9, 8, 0, TimeSpan.Zero);

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
        _app.MapGroup("/api").MapMeHistoryEndpoints();

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
                Id = SquatId, TrainerId = TrainerAId, Name = "Squat",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = BenchId, TrainerId = TrainerAId, Name = "Bench",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseBId, TrainerId = TrainerBId, Name = "SECRET_B_EXERCISE",
                IsActive = true, CreatedAt = Clock.Now,
            });

            db.Add(new WorkoutSession
            {
                Id = SessionA_OlderId, TrainerId = TrainerAId, ClientId = ClientAId,
                PerformedOn = new DateOnly(2026, 7, 15), Comment = "older",
                CreatedAt = Clock.Now,
            });
            db.Add(new WorkoutSession
            {
                Id = SessionA_NewerId, TrainerId = TrainerAId, ClientId = ClientAId,
                PerformedOn = new DateOnly(2026, 7, 20), Comment = "newer",
                CreatedAt = Clock.Now,
            });
            db.Add(new WorkoutSession
            {
                Id = SessionB_Id, TrainerId = TrainerBId, ClientId = ClientBId,
                PerformedOn = new DateOnly(2026, 7, 21), Comment = "B session",
                CreatedAt = Clock.Now,
            });

            // Older session: squat x2, then bench x1.
            db.Add(new LoggedSet
            {
                Id = SetA_Old_Squat1Id, SessionId = SessionA_OlderId, ExerciseId = SquatId,
                SetNumber = 1, WeightKg = 90m, Reps = 8, LoggedAt = T1,
            });
            db.Add(new LoggedSet
            {
                Id = SetA_Old_Squat2Id, SessionId = SessionA_OlderId, ExerciseId = SquatId,
                SetNumber = 2, WeightKg = 95m, Reps = 6, LoggedAt = T2,
            });
            db.Add(new LoggedSet
            {
                Id = SetA_Old_Bench1Id, SessionId = SessionA_OlderId, ExerciseId = BenchId,
                SetNumber = 1, WeightKg = 60m, Reps = 10, LoggedAt = T3,
            });

            // Newer session: squat x3 (this must be what /me/last?exercise_id=squat returns).
            db.Add(new LoggedSet
            {
                Id = SetA_New_Squat1Id, SessionId = SessionA_NewerId, ExerciseId = SquatId,
                SetNumber = 1, WeightKg = 100m, Reps = 8, LoggedAt = T4,
            });
            db.Add(new LoggedSet
            {
                Id = SetA_New_Squat2Id, SessionId = SessionA_NewerId, ExerciseId = SquatId,
                SetNumber = 2, WeightKg = 100m, Reps = 7, LoggedAt = T5,
            });
            db.Add(new LoggedSet
            {
                Id = SetA_New_Squat3Id, SessionId = SessionA_NewerId, ExerciseId = SquatId,
                SetNumber = 3, WeightKg = 100m, Reps = 6, LoggedAt = T6,
            });

            db.Add(new LoggedSet
            {
                Id = SetB_SecretId, SessionId = SessionB_Id, ExerciseId = ExerciseBId,
                SetNumber = 1, WeightKg = 200m, Reps = 5, LoggedAt = T6, // same time as A's newest
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

public class MeHistoryEndpointsTests : IClassFixture<MeHistoryEndpointsTestApp>
{
    private readonly MeHistoryEndpointsTestApp _app;

    public MeHistoryEndpointsTests(MeHistoryEndpointsTestApp app)
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

    // -- Role gating --

    [Fact]
    public async Task Anonymous_history_is_401()
    {
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/history", null));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Anonymous_last_is_401()
    {
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/me/last?exercise_id={_app.SquatId}", null));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Trainer_role_history_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/history", session));
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Trainer_role_last_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/me/last?exercise_id={_app.SquatId}", session));
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- /api/me/history (unfiltered) --

    [Fact]
    public async Task History_returns_all_sets_descending_by_logged_at()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/history", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var items = body.GetProperty("items");

        Assert.Equal(6, items.GetArrayLength());
        // Newest first (T6..T1).
        Assert.Equal(_app.SetA_New_Squat3Id, items[0].GetProperty("id").GetGuid());
        Assert.Equal(_app.SetA_New_Squat2Id, items[1].GetProperty("id").GetGuid());
        Assert.Equal(_app.SetA_New_Squat1Id, items[2].GetProperty("id").GetGuid());
        Assert.Equal(_app.SetA_Old_Bench1Id, items[3].GetProperty("id").GetGuid());
        Assert.Equal(_app.SetA_Old_Squat2Id, items[4].GetProperty("id").GetGuid());
        Assert.Equal(_app.SetA_Old_Squat1Id, items[5].GetProperty("id").GetGuid());

        // Shape: each item embeds session + exercise refs.
        var first = items[0];
        Assert.Equal(_app.SessionA_NewerId, first.GetProperty("session").GetProperty("id").GetGuid());
        Assert.Equal("2026-07-20", first.GetProperty("session").GetProperty("performedOn").GetString());
        Assert.Equal(_app.SquatId, first.GetProperty("exercise").GetProperty("id").GetGuid());
        Assert.Equal("Squat", first.GetProperty("exercise").GetProperty("name").GetString());

        // Fewer than limit → nextCursor is null.
        Assert.Equal(JsonValueKind.Null, body.GetProperty("nextCursor").ValueKind);
    }

    [Fact]
    public async Task History_filters_by_exercise_id()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/me/history?exercise_id={_app.SquatId}", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var items = body.GetProperty("items");

        // 5 squat sets across two sessions, newest first, no bench mixed in.
        Assert.Equal(5, items.GetArrayLength());
        var exerciseIds = items.EnumerateArray()
            .Select(i => i.GetProperty("exercise").GetProperty("id").GetGuid())
            .Distinct()
            .ToList();
        Assert.Equal([_app.SquatId], exerciseIds);
    }

    [Fact]
    public async Task History_pagination_cursor_advances_across_pages()
    {
        var session = await _app.SignInAsync(_app.ClientAId);

        // Page 1: limit 2 → gets the two newest.
        var page1 = await _app.Client.SendAsync(
            Request(HttpMethod.Get, "/api/me/history?limit=2", session));
        var page1Body = await page1.Content.ReadFromJsonAsync<JsonElement>();
        var page1Items = page1Body.GetProperty("items");
        Assert.Equal(2, page1Items.GetArrayLength());
        Assert.Equal(_app.SetA_New_Squat3Id, page1Items[0].GetProperty("id").GetGuid());
        Assert.Equal(_app.SetA_New_Squat2Id, page1Items[1].GetProperty("id").GetGuid());

        // nextCursor is the loggedAt of the last item on the page.
        var cursor = page1Body.GetProperty("nextCursor").GetDateTimeOffset();
        Assert.Equal(_app.T5, cursor);

        // Page 2: pass the cursor as before= (URL-encoded).
        var page2Path = $"/api/me/history?limit=2&before={HttpUtility.UrlEncode(cursor.ToString("O"))}";
        var page2 = await _app.Client.SendAsync(Request(HttpMethod.Get, page2Path, session));
        var page2Body = await page2.Content.ReadFromJsonAsync<JsonElement>();
        var page2Items = page2Body.GetProperty("items");
        Assert.Equal(2, page2Items.GetArrayLength());
        Assert.Equal(_app.SetA_New_Squat1Id, page2Items[0].GetProperty("id").GetGuid());
        Assert.Equal(_app.SetA_Old_Bench1Id, page2Items[1].GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task History_last_page_returns_null_next_cursor()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        // limit=100 > 6 rows total → not a full page → nextCursor null.
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, "/api/me/history?limit=100", session));

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(6, body.GetProperty("items").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("nextCursor").ValueKind);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(101)]
    public async Task History_rejects_invalid_limit(int limit)
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/me/history?limit={limit}", session));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // -- Isolation: cross-tenant params silently produce empty results, no leak --

    [Fact]
    public async Task History_with_cross_tenant_exercise_id_returns_empty_no_leak()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/me/history?exercise_id={_app.ExerciseBId}", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("SECRET_B_EXERCISE", raw);
        Assert.DoesNotContain(_app.SetB_SecretId.ToString(), raw);
        Assert.DoesNotContain(_app.ClientBId.ToString(), raw);

        var body = JsonDocument.Parse(raw).RootElement;
        Assert.Equal(0, body.GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task History_unfiltered_never_contains_client_B_data()
    {
        // Even without any filter, A's history must contain zero B artifacts —
        // the ForClient scope is doing the work, not the exercise filter.
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/history?limit=100", session));

        var raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("SECRET_B_EXERCISE", raw);
        Assert.DoesNotContain(_app.SetB_SecretId.ToString(), raw);
        Assert.DoesNotContain(_app.SessionB_Id.ToString(), raw);
        Assert.DoesNotContain(_app.ExerciseBId.ToString(), raw);
    }

    // -- /api/me/last --

    [Fact]
    public async Task Last_returns_sets_from_the_single_most_recent_session_for_the_exercise()
    {
        // Design decision: /last?exercise_id=squat returns the three squat sets from
        // A's newer session — not any squats from the older session.
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/me/last?exercise_id={_app.SquatId}", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var mostRecent = body.GetProperty("mostRecent");
        Assert.Equal(JsonValueKind.Object, mostRecent.ValueKind);

        Assert.Equal(_app.SessionA_NewerId, mostRecent.GetProperty("sessionId").GetGuid());
        Assert.Equal("2026-07-20", mostRecent.GetProperty("performedOn").GetString());
        Assert.Equal(_app.SquatId, mostRecent.GetProperty("exercise").GetProperty("id").GetGuid());
        Assert.Equal("Squat", mostRecent.GetProperty("exercise").GetProperty("name").GetString());

        var sets = mostRecent.GetProperty("sets");
        Assert.Equal(3, sets.GetArrayLength());
        // Set numbers 1..3 in order (not logged_at) — training-block reading order.
        Assert.Equal(_app.SetA_New_Squat1Id, sets[0].GetProperty("id").GetGuid());
        Assert.Equal(_app.SetA_New_Squat2Id, sets[1].GetProperty("id").GetGuid());
        Assert.Equal(_app.SetA_New_Squat3Id, sets[2].GetProperty("id").GetGuid());

        // Explicitly asserts we did NOT return squat sets from the older session.
        var setIds = sets.EnumerateArray().Select(s => s.GetProperty("id").GetGuid()).ToHashSet();
        Assert.DoesNotContain(_app.SetA_Old_Squat1Id, setIds);
        Assert.DoesNotContain(_app.SetA_Old_Squat2Id, setIds);
    }

    [Fact]
    public async Task Last_bench_returns_the_only_bench_session()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/me/last?exercise_id={_app.BenchId}", session));

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var mostRecent = body.GetProperty("mostRecent");
        Assert.Equal(_app.SessionA_OlderId, mostRecent.GetProperty("sessionId").GetGuid());
        Assert.Equal(1, mostRecent.GetProperty("sets").GetArrayLength());
    }

    [Fact]
    public async Task Last_returns_null_when_client_has_never_logged_this_exercise()
    {
        // Fresh exercise A has never done — response mirrors "no history" shape.
        var neverLogged = _app.WithDb(db =>
        {
            var e = new Exercise
            {
                Id = Guid.NewGuid(), TrainerId = _app.TrainerAId, Name = "Deadlift",
                IsActive = true, CreatedAt = FakeClock.BaseNow,
            };
            db.Add(e);
            db.SaveChanges();
            return e.Id;
        });

        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/me/last?exercise_id={neverLogged}", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, body.GetProperty("mostRecent").ValueKind);
    }

    [Fact]
    public async Task Last_with_cross_tenant_exercise_id_is_empty_shape_no_leak()
    {
        // Passing B's exercise id yields "no history" — same shape as never-logged.
        // The scoped join can't match because A has no sets against B's exercise.
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/me/last?exercise_id={_app.ExerciseBId}", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("SECRET_B_EXERCISE", raw);
        Assert.DoesNotContain(_app.SetB_SecretId.ToString(), raw);

        var body = JsonDocument.Parse(raw).RootElement;
        Assert.Equal(JsonValueKind.Null, body.GetProperty("mostRecent").ValueKind);
    }

    [Fact]
    public async Task Last_missing_exercise_id_is_400()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/last", session));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
