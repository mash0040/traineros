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

// Same two-tenant SQLite pattern as ClientEndpointsTests: the AC's core question is
// whether trainer A can ever see or mutate trainer B's exercise library, so both
// tenants exist in one process. Seeded with a logged_set against exercise A1 so the
// "logged_sets survive soft-delete" invariant (database.md resolved question 1) has
// a real row to test against.
public sealed class ExerciseEndpointsTestApp : IAsyncLifetime
{
    private readonly string _connectionString =
        $"Data Source=exercise-tests-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";

    private WebApplication _app = null!;
    private SqliteConnection _keepAlive = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;

    public Guid TrainerAId { get; } = Guid.NewGuid();
    public Guid TrainerBId { get; } = Guid.NewGuid();
    public Guid ClientA1Id { get; } = Guid.NewGuid();
    public Guid ExerciseA1Id { get; } = Guid.NewGuid();
    public Guid ExerciseA2Id { get; } = Guid.NewGuid();
    public Guid ExerciseB1Id { get; } = Guid.NewGuid();
    public Guid SessionA1Id { get; } = Guid.NewGuid();
    public Guid LoggedSetA1Id { get; } = Guid.NewGuid();

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
        _app.MapGroup("/api").MapExerciseEndpoints();

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
                Id = ClientA1Id, Role = Roles.Client, Email = "alice@example.com",
                DisplayName = "Alice", TrainerId = TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });

            db.Add(new Exercise
            {
                Id = ExerciseA1Id, TrainerId = TrainerAId, Name = "Back Squat",
                VideoUrl = "https://youtu.be/aaa", Cues = "brace hard",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseA2Id, TrainerId = TrainerAId, Name = "Bench Press",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseB1Id, TrainerId = TrainerBId, Name = "B's Deadlift",
                IsActive = true, CreatedAt = Clock.Now,
            });

            // Logged set against ExerciseA1 → proves that soft-deleting the exercise
            // does not orphan or hide the historical set (the AC's second bullet).
            db.Add(new WorkoutSession
            {
                Id = SessionA1Id, TrainerId = TrainerAId, ClientId = ClientA1Id,
                PerformedOn = new DateOnly(2026, 7, 20), CreatedAt = Clock.Now,
            });
            db.Add(new LoggedSet
            {
                Id = LoggedSetA1Id, SessionId = SessionA1Id, ExerciseId = ExerciseA1Id,
                SetNumber = 1, WeightKg = 100m, Reps = 8, LoggedAt = Clock.Now,
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

public class ExerciseEndpointsTests : IClassFixture<ExerciseEndpointsTestApp>
{
    private readonly ExerciseEndpointsTestApp _app;

    public ExerciseEndpointsTests(ExerciseEndpointsTestApp app)
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

    // -- Role gating (401 anonymous, 404 wrong role — api.md pt 4) --

    [Fact]
    public async Task Anonymous_list_is_401()
    {
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/exercises", null));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Client_role_list_is_404_not_403()
    {
        var session = await _app.SignInAsync(_app.ClientA1Id);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/exercises", session));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Client_role_create_is_404_not_403()
    {
        var session = await _app.SignInAsync(_app.ClientA1Id);
        var response = await SendAsync(HttpMethod.Post, "/api/exercises", session, new { name = "Curls" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- GET /api/exercises --

    [Fact]
    public async Task Trainer_lists_only_own_library_with_is_active()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/exercises", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        var ids = body.EnumerateArray().Select(e => e.GetProperty("id").GetGuid()).ToHashSet();
        // Contains — the shared fixture accumulates POSTed rows across tests. The two
        // safety-relevant claims are (a) both seeded A rows show up, (b) B's row never does.
        Assert.Contains(_app.ExerciseA1Id, ids);
        Assert.Contains(_app.ExerciseA2Id, ids);
        Assert.DoesNotContain(_app.ExerciseB1Id, ids);

        var first = body.EnumerateArray().First();
        Assert.True(first.TryGetProperty("isActive", out _));
    }

    // -- POST /api/exercises --

    [Fact]
    public async Task Trainer_creates_exercise_scoped_under_own_trainer_id()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/exercises", session, new
        {
            name = "Overhead Press",
            videoUrl = "https://youtu.be/ohp",
            cues = "ribs down",
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var newId = body.GetProperty("id").GetGuid();

        Assert.Equal("Overhead Press", body.GetProperty("name").GetString());
        Assert.Equal("https://youtu.be/ohp", body.GetProperty("videoUrl").GetString());
        Assert.Equal("ribs down", body.GetProperty("cues").GetString());
        Assert.True(body.GetProperty("isActive").GetBoolean());

        var persisted = _app.WithDb(db =>
            db.ExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == newId));
        Assert.Equal(_app.TrainerAId, persisted.TrainerId);
        Assert.True(persisted.IsActive);
    }

    [Fact]
    public async Task Create_defaults_optional_fields_to_null_when_omitted_or_blank()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/exercises", session, new
        {
            name = "Row",
            videoUrl = "   ",
            cues = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var newId = body.GetProperty("id").GetGuid();

        var persisted = _app.WithDb(db =>
            db.ExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == newId));
        Assert.Null(persisted.VideoUrl);
        Assert.Null(persisted.Cues);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task Create_rejects_missing_or_blank_name_with_400(string? name)
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/exercises", session, new
        {
            name,
            videoUrl = (string?)null,
            cues = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("bad_request", body.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Create_rejects_unknown_body_fields()
    {
        // api.md §Cross-cutting: unknown fields rejected, not ignored.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/exercises", session, new
        {
            name = "Sneaky",
            trainerId = Guid.NewGuid(), // attempt to redirect ownership
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // -- PATCH /api/exercises/:id --

    [Fact]
    public async Task Patch_updates_name_video_and_cues()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/exercises/{_app.ExerciseA2Id}", session, new
        {
            name = "Bench Press (paused)",
            videoUrl = "https://youtu.be/bench",
            cues = "chest up",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == _app.ExerciseA2Id));
        Assert.Equal("Bench Press (paused)", persisted.Name);
        Assert.Equal("https://youtu.be/bench", persisted.VideoUrl);
        Assert.Equal("chest up", persisted.Cues);
        Assert.True(persisted.IsActive);
    }

    [Fact]
    public async Task Patch_leaves_untouched_fields_alone()
    {
        // Seed a fresh exercise inside the test to avoid cross-test interference through
        // the shared fixture — other tests mutate A1/A2.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var created = await CreateExerciseAsync(session, "Untouched Row", "https://youtu.be/keep", "keep cue");

        var response = await SendAsync(HttpMethod.Patch, $"/api/exercises/{created}", session, new
        {
            cues = "new cue",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == created));
        Assert.Equal("Untouched Row", persisted.Name);
        Assert.Equal("https://youtu.be/keep", persisted.VideoUrl);
        Assert.Equal("new cue", persisted.Cues);
    }

    [Fact]
    public async Task Patch_with_blank_video_url_clears_to_null()
    {
        // The only escape hatch for wiping a nullable field via PATCH — null on the wire
        // means "not sent", so blank-string-to-null is how a trainer removes a video link.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var created = await CreateExerciseAsync(session, "Clearable", "https://youtu.be/clear", null);

        var response = await SendAsync(HttpMethod.Patch, $"/api/exercises/{created}", session, new
        {
            videoUrl = "",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == created));
        Assert.Null(persisted.VideoUrl);
    }

    private async Task<Guid> CreateExerciseAsync(Guid session, string name, string? videoUrl, string? cues)
    {
        var response = await SendAsync(HttpMethod.Post, "/api/exercises", session, new
        {
            name, videoUrl, cues,
        });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("id").GetGuid();
    }

    [Fact]
    public async Task Patch_with_blank_name_is_400()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/exercises/{_app.ExerciseA2Id}", session, new
        {
            name = "   ",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // -- Soft-delete AC --

    [Fact]
    public async Task Patch_is_active_false_soft_deletes_and_can_be_reactivated()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);

        var deactivate = await SendAsync(HttpMethod.Patch, $"/api/exercises/{_app.ExerciseA2Id}", session, new
        {
            isActive = false,
        });
        Assert.Equal(HttpStatusCode.OK, deactivate.StatusCode);

        var afterDeactivate = _app.WithDb(db =>
            db.ExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == _app.ExerciseA2Id));
        Assert.False(afterDeactivate.IsActive);

        var reactivate = await SendAsync(HttpMethod.Patch, $"/api/exercises/{_app.ExerciseA2Id}", session, new
        {
            isActive = true,
        });
        Assert.Equal(HttpStatusCode.OK, reactivate.StatusCode);

        var afterReactivate = _app.WithDb(db =>
            db.ExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == _app.ExerciseA2Id));
        Assert.True(afterReactivate.IsActive);
    }

    // AC: "logged_sets referencing a soft-deleted exercise remain valid."
    [Fact]
    public async Task Soft_deleting_exercise_keeps_logged_sets_referencing_it()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/exercises/{_app.ExerciseA1Id}", session, new
        {
            isActive = false,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        // The exercise row still exists, so the FK from logged_sets still resolves —
        // hard-delete would have violated RESTRICT and lost ground truth (principle 4).
        var (exerciseStillThere, setStillPointsAtIt) = _app.WithDb(db => (
            db.ExercisesForTrainer(_app.TrainerAId)
                .AsNoTracking().Any(e => e.Id == _app.ExerciseA1Id && !e.IsActive),
            db.LoggedSetsForTrainer(_app.TrainerAId)
                .AsNoTracking().Any(s => s.Id == _app.LoggedSetA1Id && s.ExerciseId == _app.ExerciseA1Id)
        ));

        Assert.True(exerciseStillThere);
        Assert.True(setStillPointsAtIt);
    }

    // -- Isolation (conventions.md §Isolation tests / api.md pt 2) --

    [Fact]
    public async Task Patching_another_trainers_exercise_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/exercises/{_app.ExerciseB1Id}", session, new
        {
            name = "Hijack",
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        var untouched = _app.WithDb(db => db.Find<Exercise>(_app.ExerciseB1Id)!);
        Assert.Equal("B's Deadlift", untouched.Name);
    }

    [Fact]
    public async Task Nonexistent_exercise_id_is_404_indistinguishable_from_cross_tenant()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var madeUp = Guid.NewGuid();

        var madeUpPatch = await SendAsync(
            HttpMethod.Patch, $"/api/exercises/{madeUp}", session, new { name = "x" });
        var otherPatch = await SendAsync(
            HttpMethod.Patch, $"/api/exercises/{_app.ExerciseB1Id}", session, new { name = "x" });

        Assert.Equal(HttpStatusCode.NotFound, madeUpPatch.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, otherPatch.StatusCode);
        Assert.Equal(
            await madeUpPatch.Content.ReadAsStringAsync(),
            await otherPatch.Content.ReadAsStringAsync());
    }
}
