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

using ProgramEntity = TrainerOS.Domain.Entities.Program;

namespace TrainerOS.Tests;

// Two full tenants each with a complete program tree — active program, 2 days,
// 2 prescriptions per day, exercises with video and cues — so the isolation
// assertion has real cross-tenant data to reject and the shape assertions have
// real nested content to verify.
public sealed class MeEndpointsTestApp : IAsyncLifetime
{
    private readonly string _connectionString =
        $"Data Source=me-tests-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";

    private WebApplication _app = null!;
    private SqliteConnection _keepAlive = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;

    public Guid TrainerAId { get; } = Guid.NewGuid();
    public Guid TrainerBId { get; } = Guid.NewGuid();

    // Client A has an active program (rich tree).
    public Guid ClientAId { get; } = Guid.NewGuid();
    // Client A2 has no active program (only a draft) — proves /program returns 404.
    public Guid ClientA2Id { get; } = Guid.NewGuid();
    // Client B has an active program under trainer B — the isolation target.
    public Guid ClientBId { get; } = Guid.NewGuid();

    public Guid ProgramA_ActiveId { get; } = Guid.NewGuid();
    public Guid ProgramA2_DraftId { get; } = Guid.NewGuid();
    public Guid ProgramB_ActiveId { get; } = Guid.NewGuid();

    public Guid DayA1Id { get; } = Guid.NewGuid();
    public Guid DayA2Id { get; } = Guid.NewGuid();
    public Guid DayBId { get; } = Guid.NewGuid();

    public Guid ExerciseA_SquatId { get; } = Guid.NewGuid();
    public Guid ExerciseA_BenchId { get; } = Guid.NewGuid();
    public Guid ExerciseA_RowId { get; } = Guid.NewGuid();
    public Guid ExerciseBId { get; } = Guid.NewGuid();

    public Guid RxA1SquatId { get; } = Guid.NewGuid();
    public Guid RxA1BenchId { get; } = Guid.NewGuid();
    public Guid RxA2RowId { get; } = Guid.NewGuid();
    public Guid RxBId { get; } = Guid.NewGuid();

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
        _app.MapGroup("/api").MapMeEndpoints();

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
                Id = ClientA2Id, Role = Roles.Client, Email = "bob@example.com",
                DisplayName = "Bob", TrainerId = TrainerAId, Timezone = "America/Toronto",
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
                Id = ExerciseA_SquatId, TrainerId = TrainerAId, Name = "Back Squat",
                VideoUrl = "https://youtu.be/squat", Cues = "brace hard",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseA_BenchId, TrainerId = TrainerAId, Name = "Bench Press",
                VideoUrl = "https://youtu.be/bench", Cues = "shoulders down",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseA_RowId, TrainerId = TrainerAId, Name = "Barbell Row",
                VideoUrl = null, Cues = null,
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseBId, TrainerId = TrainerBId, Name = "SECRET_B_EXERCISE",
                VideoUrl = "https://youtu.be/leak", Cues = "should never appear for A",
                IsActive = true, CreatedAt = Clock.Now,
            });

            db.Add(new ProgramEntity
            {
                Id = ProgramA_ActiveId, TrainerId = TrainerAId, ClientId = ClientAId,
                Title = "Alice's Block", Status = ProgramStatuses.Active,
                StartsOn = new DateOnly(2026, 7, 1),
                CreatedAt = Clock.Now, UpdatedAt = Clock.Now,
            });
            db.Add(new ProgramEntity
            {
                Id = ProgramA2_DraftId, TrainerId = TrainerAId, ClientId = ClientA2Id,
                Title = "Bob's Draft", Status = ProgramStatuses.Draft,
                CreatedAt = Clock.Now, UpdatedAt = Clock.Now,
            });
            db.Add(new ProgramEntity
            {
                Id = ProgramB_ActiveId, TrainerId = TrainerBId, ClientId = ClientBId,
                Title = "SECRET_B_PROGRAM", Status = ProgramStatuses.Active,
                CreatedAt = Clock.Now, UpdatedAt = Clock.Now,
            });

            // Day positions seeded out of insertion order to prove the endpoint sorts.
            db.Add(new ProgramDay { Id = DayA2Id, ProgramId = ProgramA_ActiveId, Title = "Day B — Pull", Position = 2 });
            db.Add(new ProgramDay { Id = DayA1Id, ProgramId = ProgramA_ActiveId, Title = "Day A — Push", Position = 1 });
            db.Add(new ProgramDay { Id = DayBId, ProgramId = ProgramB_ActiveId, Title = "B's Day", Position = 1 });

            // Prescription positions inside Day A: squat @2, bench @1 → sorted output must be bench-first.
            db.Add(new ProgramDayExercise
            {
                Id = RxA1SquatId, ProgramDayId = DayA1Id, ExerciseId = ExerciseA_SquatId,
                Position = 2, TargetSets = 5, TargetReps = "5", TargetLoad = "80%",
                RestSeconds = 180, Note = "top set + backoffs",
            });
            db.Add(new ProgramDayExercise
            {
                Id = RxA1BenchId, ProgramDayId = DayA1Id, ExerciseId = ExerciseA_BenchId,
                Position = 1, TargetSets = 4, TargetReps = "8-10", TargetLoad = null,
                RestSeconds = 120, Note = null,
            });
            db.Add(new ProgramDayExercise
            {
                Id = RxA2RowId, ProgramDayId = DayA2Id, ExerciseId = ExerciseA_RowId,
                Position = 1, TargetSets = 3, TargetReps = "AMRAP", TargetLoad = null,
                RestSeconds = null, Note = null,
            });
            db.Add(new ProgramDayExercise
            {
                Id = RxBId, ProgramDayId = DayBId, ExerciseId = ExerciseBId,
                Position = 1, TargetSets = 3, TargetReps = "5", TargetLoad = null,
                RestSeconds = null, Note = null,
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

public class MeEndpointsTests : IClassFixture<MeEndpointsTestApp>
{
    private readonly MeEndpointsTestApp _app;

    public MeEndpointsTests(MeEndpointsTestApp app)
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
    public async Task Anonymous_get_me_is_401()
    {
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me", null));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Anonymous_get_program_is_401()
    {
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/program", null));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Trainer_role_get_me_is_404_not_403()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me", session));
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Trainer_role_get_program_is_404_not_403()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/program", session));
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- GET /api/me --

    [Fact]
    public async Task Get_me_returns_identity_and_active_program_summary()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(_app.ClientAId, body.GetProperty("id").GetGuid());
        Assert.Equal("alice@example.com", body.GetProperty("email").GetString());
        Assert.Equal("Alice", body.GetProperty("displayName").GetString());
        Assert.Equal("America/Toronto", body.GetProperty("timezone").GetString());

        var summary = body.GetProperty("activeProgram");
        Assert.Equal(JsonValueKind.Object, summary.ValueKind);
        Assert.Equal(_app.ProgramA_ActiveId, summary.GetProperty("id").GetGuid());
        Assert.Equal("Alice's Block", summary.GetProperty("title").GetString());
    }

    [Fact]
    public async Task Get_me_returns_null_active_program_when_only_draft_exists()
    {
        var session = await _app.SignInAsync(_app.ClientA2Id);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, body.GetProperty("activeProgram").ValueKind);
    }

    // -- GET /api/me/program --

    [Fact]
    public async Task Get_program_returns_nested_days_prescriptions_exercises_sorted_by_position()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/program", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var program = body.GetProperty("program");
        Assert.Equal(JsonValueKind.Object, program.ValueKind);

        Assert.Equal(_app.ProgramA_ActiveId, program.GetProperty("id").GetGuid());
        Assert.Equal(ProgramStatuses.Active, program.GetProperty("status").GetString());
        Assert.Equal("2026-07-01", program.GetProperty("startsOn").GetString());

        var days = program.GetProperty("days");
        Assert.Equal(2, days.GetArrayLength());

        // Days ordered by position 1 → 2 (seeded out of insertion order).
        Assert.Equal(_app.DayA1Id, days[0].GetProperty("id").GetGuid());
        Assert.Equal(1, days[0].GetProperty("position").GetInt32());
        Assert.Equal(_app.DayA2Id, days[1].GetProperty("id").GetGuid());
        Assert.Equal(2, days[1].GetProperty("position").GetInt32());

        // Day A1 has two prescriptions, seeded with bench @1, squat @2. Output must
        // be bench-first (position ordering, not insertion order).
        var dayA1Prescriptions = days[0].GetProperty("prescriptions");
        Assert.Equal(2, dayA1Prescriptions.GetArrayLength());
        Assert.Equal(_app.RxA1BenchId, dayA1Prescriptions[0].GetProperty("id").GetGuid());
        Assert.Equal(_app.RxA1SquatId, dayA1Prescriptions[1].GetProperty("id").GetGuid());

        // Exercise inlined into the prescription — no separate lookup call needed.
        var benchRx = dayA1Prescriptions[0];
        Assert.Equal(4, benchRx.GetProperty("targetSets").GetInt32());
        Assert.Equal("8-10", benchRx.GetProperty("targetReps").GetString());

        var benchExercise = benchRx.GetProperty("exercise");
        Assert.Equal(_app.ExerciseA_BenchId, benchExercise.GetProperty("id").GetGuid());
        Assert.Equal("Bench Press", benchExercise.GetProperty("name").GetString());
        Assert.Equal("https://youtu.be/bench", benchExercise.GetProperty("videoUrl").GetString());
        Assert.Equal("shoulders down", benchExercise.GetProperty("cues").GetString());

        // Nullable exercise fields survive as JSON null (barbell row has no video/cues).
        var rowExercise = days[1].GetProperty("prescriptions")[0].GetProperty("exercise");
        Assert.Equal(_app.ExerciseA_RowId, rowExercise.GetProperty("id").GetGuid());
        Assert.Equal(JsonValueKind.Null, rowExercise.GetProperty("videoUrl").ValueKind);
        Assert.Equal(JsonValueKind.Null, rowExercise.GetProperty("cues").ValueKind);
    }

    [Fact]
    public async Task Get_program_returns_200_with_null_program_when_no_active_program()
    {
        var session = await _app.SignInAsync(_app.ClientA2Id);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/program", session));

        // ClientA2 has only a draft — no active program to render. Mirrors /api/me's
        // activeProgram: null for the same condition, so the SPA has one empty-state
        // shape across both endpoints instead of "200-with-null vs 404" per endpoint.
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, body.GetProperty("program").ValueKind);
    }

    // -- Isolation (api.md §5 — the mandatory client-facing isolation test) --

    [Fact]
    public async Task Client_A_never_sees_client_B_data_across_me_endpoints()
    {
        // Sign in as A; every response body must contain zero references to B's data.
        // The B tenant seeds SECRET_B_EXERCISE and SECRET_B_PROGRAM strings so any leak
        // is visible as a substring.
        var session = await _app.SignInAsync(_app.ClientAId);

        var me = await (await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me", session)))
            .Content.ReadAsStringAsync();
        var program = await (await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/program", session)))
            .Content.ReadAsStringAsync();

        Assert.DoesNotContain("SECRET_B_EXERCISE", me);
        Assert.DoesNotContain("SECRET_B_PROGRAM", me);
        Assert.DoesNotContain(_app.ClientBId.ToString(), me);
        Assert.DoesNotContain(_app.ProgramB_ActiveId.ToString(), me);

        Assert.DoesNotContain("SECRET_B_EXERCISE", program);
        Assert.DoesNotContain("SECRET_B_PROGRAM", program);
        Assert.DoesNotContain(_app.ClientBId.ToString(), program);
        Assert.DoesNotContain(_app.ProgramB_ActiveId.ToString(), program);
        Assert.DoesNotContain(_app.ExerciseBId.ToString(), program);
        Assert.DoesNotContain(_app.RxBId.ToString(), program);
        Assert.DoesNotContain(_app.DayBId.ToString(), program);
    }

    [Fact]
    public async Task Client_B_sees_only_their_own_program()
    {
        // Symmetric: B's session sees B's program and no A rows.
        var session = await _app.SignInAsync(_app.ClientBId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/program", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(_app.ProgramB_ActiveId, body.GetProperty("program").GetProperty("id").GetGuid());

        var raw = await (await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/me/program", session)))
            .Content.ReadAsStringAsync();
        Assert.DoesNotContain(_app.ProgramA_ActiveId.ToString(), raw);
        Assert.DoesNotContain(_app.ExerciseA_SquatId.ToString(), raw);
    }
}
