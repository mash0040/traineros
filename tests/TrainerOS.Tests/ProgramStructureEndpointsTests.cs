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

// Two full tenants each with a program, a day, and a prescription — so every AC in
// #28 (days CRUD, prescription CRUD, reorder-in-one-transaction, ownership by join,
// 404 rule) has a real cross-tenant sibling to test isolation against.
public sealed class ProgramStructureEndpointsTestApp : IAsyncLifetime
{
    private readonly string _connectionString =
        $"Data Source=program-structure-tests-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";

    private WebApplication _app = null!;
    private SqliteConnection _keepAlive = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;

    public Guid TrainerAId { get; } = Guid.NewGuid();
    public Guid TrainerBId { get; } = Guid.NewGuid();
    public Guid ClientA1Id { get; } = Guid.NewGuid();
    public Guid ClientB1Id { get; } = Guid.NewGuid();

    public Guid ProgramAId { get; } = Guid.NewGuid();
    public Guid ProgramBId { get; } = Guid.NewGuid();

    public Guid ExerciseA_SquatId { get; } = Guid.NewGuid();
    public Guid ExerciseA_BenchId { get; } = Guid.NewGuid();
    public Guid ExerciseA_InactiveId { get; } = Guid.NewGuid();
    public Guid ExerciseBId { get; } = Guid.NewGuid();

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
        var group = _app.MapGroup("/api");
        group.MapProgramDayEndpoints();
        group.MapProgramDayExerciseEndpoints();

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
            db.Add(new User
            {
                Id = ClientB1Id, Role = Roles.Client, Email = "carol@example.com",
                DisplayName = "Carol", TrainerId = TrainerBId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });

            db.Add(new ProgramEntity
            {
                Id = ProgramAId, TrainerId = TrainerAId, ClientId = ClientA1Id,
                Title = "A Block", Status = ProgramStatuses.Draft,
                CreatedAt = Clock.Now, UpdatedAt = Clock.Now,
            });
            db.Add(new ProgramEntity
            {
                Id = ProgramBId, TrainerId = TrainerBId, ClientId = ClientB1Id,
                Title = "B Block", Status = ProgramStatuses.Draft,
                CreatedAt = Clock.Now, UpdatedAt = Clock.Now,
            });

            db.Add(new Exercise
            {
                Id = ExerciseA_SquatId, TrainerId = TrainerAId, Name = "Squat",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseA_BenchId, TrainerId = TrainerAId, Name = "Bench",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseA_InactiveId, TrainerId = TrainerAId, Name = "Retired",
                IsActive = false, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseBId, TrainerId = TrainerBId, Name = "B's Deadlift",
                IsActive = true, CreatedAt = Clock.Now,
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

public class ProgramStructureEndpointsTests : IClassFixture<ProgramStructureEndpointsTestApp>
{
    private readonly ProgramStructureEndpointsTestApp _app;

    public ProgramStructureEndpointsTests(ProgramStructureEndpointsTestApp app)
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

    private async Task<Guid> CreateDayAsync(Guid session, Guid programId, string title)
    {
        var response = await SendAsync(HttpMethod.Post, $"/api/programs/{programId}/days", session, new { title });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("id").GetGuid();
    }

    private async Task<Guid> CreatePrescriptionAsync(
        Guid session, Guid dayId, Guid exerciseId, int targetSets = 3, string targetReps = "8-10")
    {
        var response = await SendAsync(HttpMethod.Post, $"/api/days/{dayId}/exercises", session, new
        {
            exerciseId,
            targetSets,
            targetReps,
            targetLoad = (string?)null,
            restSeconds = (int?)null,
            note = (string?)null,
        });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("id").GetGuid();
    }

    // -- Role gating --

    [Fact]
    public async Task Anonymous_create_day_is_401()
    {
        // Body has to be well-formed for the role-gate filter to run — malformed body
        // bindings 400 out ahead of the auth pipeline (RouteHandlerOptions.ThrowOnBadRequest).
        var request = Request(HttpMethod.Post, $"/api/programs/{_app.ProgramAId}/days", null);
        request.Content = JsonContent.Create(new { title = "Anon Attempt" });

        var response = await _app.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Client_role_create_day_is_404_not_403()
    {
        var session = await _app.SignInAsync(_app.ClientA1Id);
        var response = await SendAsync(
            HttpMethod.Post, $"/api/programs/{_app.ProgramAId}/days", session, new { title = "Nope" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- POST /api/programs/:id/days --

    [Fact]
    public async Task Trainer_creates_day_with_server_assigned_position()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var programId = _app.WithDb(db =>
        {
            var p = new ProgramEntity
            {
                Id = Guid.NewGuid(), TrainerId = _app.TrainerAId, ClientId = _app.ClientA1Id,
                Title = "Position Program", Status = ProgramStatuses.Draft,
                CreatedAt = FakeClock.BaseNow, UpdatedAt = FakeClock.BaseNow,
            };
            db.Add(p);
            db.SaveChanges();
            return p.Id;
        });

        var first = await CreateDayAsync(session, programId, "Day A");
        var second = await CreateDayAsync(session, programId, "Day B");

        var positions = _app.WithDb(db => db.ProgramDaysForTrainer(_app.TrainerAId)
            .Where(d => d.ProgramId == programId)
            .OrderBy(d => d.Position)
            .Select(d => new { d.Id, d.Position })
            .ToList());

        Assert.Equal([1, 2], positions.Select(p => p.Position).ToList());
        Assert.Equal(first, positions[0].Id);
        Assert.Equal(second, positions[1].Id);
    }

    [Fact]
    public async Task Create_day_rejects_blank_title()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Post, $"/api/programs/{_app.ProgramAId}/days", session, new { title = "   " });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Create_day_under_another_trainers_program_is_404()
    {
        // Route-param identity check: cross-tenant program id collapses to the same 404
        // as a fabricated id (api.md #27 clarification).
        var session = await _app.SignInAsync(_app.TrainerAId);
        var crossTenant = await SendAsync(
            HttpMethod.Post, $"/api/programs/{_app.ProgramBId}/days", session, new { title = "Hijack" });
        var madeUp = await SendAsync(
            HttpMethod.Post, $"/api/programs/{Guid.NewGuid()}/days", session, new { title = "Ghost" });

        Assert.Equal(HttpStatusCode.NotFound, crossTenant.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, madeUp.StatusCode);

        // Capture-around: the shared fixture accumulates state, so an equality-to-zero
        // check is fragile. What matters is that the trainer-A request did not add a
        // row under trainer-B's program.
        var beforeCount = _app.WithDb(db =>
            db.ProgramDaysForTrainer(_app.TrainerBId).Count(d => d.ProgramId == _app.ProgramBId));
        var again = await SendAsync(
            HttpMethod.Post, $"/api/programs/{_app.ProgramBId}/days", session, new { title = "Hijack2" });
        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
        var afterCount = _app.WithDb(db =>
            db.ProgramDaysForTrainer(_app.TrainerBId).Count(d => d.ProgramId == _app.ProgramBId));
        Assert.Equal(beforeCount, afterCount);
    }

    // -- PATCH /api/days/:id --

    [Fact]
    public async Task Patch_day_updates_title_and_position()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Original");

        var response = await SendAsync(HttpMethod.Patch, $"/api/days/{dayId}", session, new
        {
            title = "Renamed",
            position = 5,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ProgramDaysForTrainer(_app.TrainerAId).AsNoTracking().Single(d => d.Id == dayId));
        Assert.Equal("Renamed", persisted.Title);
        Assert.Equal(5, persisted.Position);
    }

    [Fact]
    public async Task Patch_day_blank_title_is_400()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "T");

        var response = await SendAsync(HttpMethod.Patch, $"/api/days/{dayId}", session, new
        {
            title = "   ",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Patch_day_of_another_trainer_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var otherDayId = _app.WithDb(db =>
        {
            var d = new ProgramDay
            {
                Id = Guid.NewGuid(), ProgramId = _app.ProgramBId, Title = "B's Day", Position = 1,
            };
            db.Add(d);
            db.SaveChanges();
            return d.Id;
        });

        var response = await SendAsync(HttpMethod.Patch, $"/api/days/{otherDayId}", session, new
        {
            title = "Hijack",
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        var untouched = _app.WithDb(db => db.Find<ProgramDay>(otherDayId)!);
        Assert.Equal("B's Day", untouched.Title);
    }

    // -- DELETE /api/days/:id --

    [Fact]
    public async Task Delete_day_cascades_prescriptions_and_nulls_workout_session_link()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Doomed");
        var prescriptionId = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);

        var workoutSessionId = _app.WithDb(db =>
        {
            var s = new WorkoutSession
            {
                Id = Guid.NewGuid(), TrainerId = _app.TrainerAId, ClientId = _app.ClientA1Id,
                ProgramDayId = dayId, PerformedOn = new DateOnly(2026, 7, 20), CreatedAt = FakeClock.BaseNow,
            };
            db.Add(s);
            db.SaveChanges();
            return s.Id;
        });

        var response = await SendAsync(HttpMethod.Delete, $"/api/days/{dayId}", session);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        var (dayGone, prescriptionGone, workoutStillThere) = _app.WithDb(db => (
            db.ProgramDaysForTrainer(_app.TrainerAId).AsNoTracking().Any(d => d.Id == dayId),
            db.ProgramDayExercisesForTrainer(_app.TrainerAId).AsNoTracking().Any(e => e.Id == prescriptionId),
            db.WorkoutSessionsForTrainer(_app.TrainerAId).AsNoTracking()
                .Single(w => w.Id == workoutSessionId)
        ));

        Assert.False(dayGone);
        Assert.False(prescriptionGone);
        // database.md principle 4: logs survive program edits. workout_sessions.program_day_id
        // is SET NULL, so history is retained without a dangling FK.
        Assert.Null(workoutStillThere.ProgramDayId);
    }

    [Fact]
    public async Task Delete_day_of_another_trainer_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var otherDayId = _app.WithDb(db =>
        {
            var d = new ProgramDay
            {
                Id = Guid.NewGuid(), ProgramId = _app.ProgramBId, Title = "B's Day", Position = 1,
            };
            db.Add(d);
            db.SaveChanges();
            return d.Id;
        });

        var response = await SendAsync(HttpMethod.Delete, $"/api/days/{otherDayId}", session);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.NotNull(_app.WithDb(db => db.Find<ProgramDay>(otherDayId)));
    }

    // -- POST /api/days/:id/exercises --

    [Fact]
    public async Task Create_prescription_appends_at_next_position()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Position Day");

        var p1 = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);
        var p2 = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_BenchId);

        var ordered = _app.WithDb(db => db.ProgramDayExercisesForTrainer(_app.TrainerAId)
            .Where(e => e.ProgramDayId == dayId)
            .OrderBy(e => e.Position)
            .Select(e => new { e.Id, e.Position })
            .ToList());

        Assert.Equal([(p1, 1), (p2, 2)], ordered.Select(o => (o.Id, o.Position)).ToList());
    }

    [Fact]
    public async Task Create_prescription_with_full_body_persists_all_fields()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Detail Day");

        var response = await SendAsync(HttpMethod.Post, $"/api/days/{dayId}/exercises", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            targetSets = 5,
            targetReps = "5/3/1",       // free-text prescription per database.md
            targetLoad = "RPE 8",
            restSeconds = 180,
            note = "brace hard",
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var newId = body.GetProperty("id").GetGuid();

        var persisted = _app.WithDb(db =>
            db.ProgramDayExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == newId));
        Assert.Equal(_app.ExerciseA_SquatId, persisted.ExerciseId);
        Assert.Equal(5, persisted.TargetSets);
        Assert.Equal("5/3/1", persisted.TargetReps);
        Assert.Equal("RPE 8", persisted.TargetLoad);
        Assert.Equal(180, persisted.RestSeconds);
        Assert.Equal("brace hard", persisted.Note);
    }

    [Fact]
    public async Task Create_prescription_rejects_zero_or_negative_target_sets()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Reject Sets");

        var zero = await SendAsync(HttpMethod.Post, $"/api/days/{dayId}/exercises", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            targetSets = 0,
            targetReps = "5",
            targetLoad = (string?)null,
            restSeconds = (int?)null,
            note = (string?)null,
        });
        var negative = await SendAsync(HttpMethod.Post, $"/api/days/{dayId}/exercises", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            targetSets = -1,
            targetReps = "5",
            targetLoad = (string?)null,
            restSeconds = (int?)null,
            note = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, zero.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, negative.StatusCode);
    }

    [Fact]
    public async Task Create_prescription_rejects_blank_target_reps()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Reject Reps");

        var response = await SendAsync(HttpMethod.Post, $"/api/days/{dayId}/exercises", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            targetSets = 3,
            targetReps = "   ",
            targetLoad = (string?)null,
            restSeconds = (int?)null,
            note = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Create_prescription_under_another_trainers_day_is_404()
    {
        // Route-param identity check on the day id.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var otherDayId = _app.WithDb(db =>
        {
            var d = new ProgramDay
            {
                Id = Guid.NewGuid(), ProgramId = _app.ProgramBId, Title = "B's Day", Position = 1,
            };
            db.Add(d);
            db.SaveChanges();
            return d.Id;
        });

        var response = await SendAsync(HttpMethod.Post, $"/api/days/{otherDayId}/exercises", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            targetSets = 3,
            targetReps = "8",
            targetLoad = (string?)null,
            restSeconds = (int?)null,
            note = (string?)null,
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Create_prescription_with_cross_tenant_or_unknown_exercise_id_is_400_unknown_exercise()
    {
        // Body-field identity check: cross-tenant and truly-unknown collapse to the same
        // 400 unknown_exercise (api.md #27 clarification).
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Bad Ex Day");

        var crossTenant = await SendAsync(HttpMethod.Post, $"/api/days/{dayId}/exercises", session, new
        {
            exerciseId = _app.ExerciseBId,
            targetSets = 3,
            targetReps = "8",
            targetLoad = (string?)null,
            restSeconds = (int?)null,
            note = (string?)null,
        });
        var madeUp = await SendAsync(HttpMethod.Post, $"/api/days/{dayId}/exercises", session, new
        {
            exerciseId = Guid.NewGuid(),
            targetSets = 3,
            targetReps = "8",
            targetLoad = (string?)null,
            restSeconds = (int?)null,
            note = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, crossTenant.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, madeUp.StatusCode);
        Assert.Equal(
            "unknown_exercise",
            (await crossTenant.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(
            "unknown_exercise",
            (await madeUp.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Create_prescription_with_soft_deleted_exercise_is_400_unknown_exercise()
    {
        // Retired-from-library is the intent of soft-delete on exercises. Adding a
        // retired exercise to a new prescription would resurrect it silently.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Retired Attempt");

        var response = await SendAsync(HttpMethod.Post, $"/api/days/{dayId}/exercises", session, new
        {
            exerciseId = _app.ExerciseA_InactiveId,
            targetSets = 3,
            targetReps = "8",
            targetLoad = (string?)null,
            restSeconds = (int?)null,
            note = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("unknown_exercise", body.GetProperty("error").GetProperty("code").GetString());
    }

    // -- PATCH /api/day-exercises/:id --

    [Fact]
    public async Task Patch_prescription_updates_editable_fields()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Edit Rx");
        var pId = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/day-exercises/{pId}", session, new
        {
            targetSets = 4,
            targetReps = "6-8",
            targetLoad = "80%",
            restSeconds = 120,
            note = "keep bar path tight",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ProgramDayExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == pId));
        Assert.Equal(4, persisted.TargetSets);
        Assert.Equal("6-8", persisted.TargetReps);
        Assert.Equal("80%", persisted.TargetLoad);
        Assert.Equal(120, persisted.RestSeconds);
        Assert.Equal("keep bar path tight", persisted.Note);
    }

    [Fact]
    public async Task Patch_prescription_can_swap_exercise_when_owned_and_active()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Swap");
        var pId = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/day-exercises/{pId}", session, new
        {
            exerciseId = _app.ExerciseA_BenchId,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ProgramDayExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == pId));
        Assert.Equal(_app.ExerciseA_BenchId, persisted.ExerciseId);
    }

    [Fact]
    public async Task Patch_prescription_swap_to_cross_tenant_exercise_is_400_unknown_exercise()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Bad Swap");
        var pId = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/day-exercises/{pId}", session, new
        {
            exerciseId = _app.ExerciseBId,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("unknown_exercise", body.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Patch_prescription_null_note_clears_it()
    {
        // #145: null clears, replacing #26's blank-string sentinel.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Clear Note");
        var pId = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);

        await SendAsync(HttpMethod.Patch, $"/api/day-exercises/{pId}", session, new
        {
            note = "start value",
        });

        var response = await SendAsync(HttpMethod.Patch, $"/api/day-exercises/{pId}", session, new
        {
            note = (string?)null,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ProgramDayExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == pId));
        Assert.Null(persisted.Note);
    }

    [Fact]
    public async Task Patch_prescription_null_rest_seconds_clears_it()
    {
        // The unreported half of #145, and the one that was costing a trainer something today.
        // The builder sends rest_seconds: null when the field is emptied; the old "null = leave
        // alone" reading put the previous value straight back with a 200 and no message. Unlike
        // the bodyweight case the issue was opened for, the SPA did not know to refuse it, so
        // there was nothing on screen to explain why the number came back.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Clear Rest");
        var pId = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);

        await SendAsync(HttpMethod.Patch, $"/api/day-exercises/{pId}", session, new
        {
            restSeconds = 90,
        });

        var response = await SendAsync(HttpMethod.Patch, $"/api/day-exercises/{pId}", session, new
        {
            restSeconds = (int?)null,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ProgramDayExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == pId));
        Assert.Null(persisted.RestSeconds);
    }

    [Fact]
    public async Task Patch_prescription_omitting_rest_seconds_leaves_it_alone()
    {
        // The half that makes the clear safe. Absent and null were the same value before #145.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Keep Rest");
        var pId = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);

        await SendAsync(HttpMethod.Patch, $"/api/day-exercises/{pId}", session, new
        {
            restSeconds = 120,
        });

        var response = await SendAsync(HttpMethod.Patch, $"/api/day-exercises/{pId}", session, new
        {
            targetSets = 4,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ProgramDayExercisesForTrainer(_app.TrainerAId).AsNoTracking().Single(e => e.Id == pId));
        Assert.Equal(120, persisted.RestSeconds);
        Assert.Equal(4, persisted.TargetSets);
    }

    [Fact]
    public async Task Patch_prescription_null_target_reps_is_400()
    {
        // target_reps backs a NOT NULL column. Refused, where before #145 it was read as
        // "leave alone" and answered 200.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Null Reps");
        var pId = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/day-exercises/{pId}", session, new
        {
            targetReps = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Patch_prescription_of_another_trainer_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var otherPrescriptionId = _app.WithDb(db =>
        {
            var d = new ProgramDay
            {
                Id = Guid.NewGuid(), ProgramId = _app.ProgramBId, Title = "B Day", Position = 1,
            };
            db.Add(d);
            var e = new ProgramDayExercise
            {
                Id = Guid.NewGuid(), ProgramDayId = d.Id, ExerciseId = _app.ExerciseBId,
                Position = 1, TargetSets = 3, TargetReps = "5",
            };
            db.Add(e);
            db.SaveChanges();
            return e.Id;
        });

        var response = await SendAsync(HttpMethod.Patch, $"/api/day-exercises/{otherPrescriptionId}", session, new
        {
            targetSets = 99,
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        var untouched = _app.WithDb(db => db.Find<ProgramDayExercise>(otherPrescriptionId)!);
        Assert.Equal(3, untouched.TargetSets);
    }

    // -- DELETE /api/day-exercises/:id --

    [Fact]
    public async Task Delete_prescription_nulls_program_day_exercise_id_on_logged_sets()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Delete Rx");
        var pId = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);

        var loggedSetId = _app.WithDb(db =>
        {
            var ws = new WorkoutSession
            {
                Id = Guid.NewGuid(), TrainerId = _app.TrainerAId, ClientId = _app.ClientA1Id,
                PerformedOn = new DateOnly(2026, 7, 20), CreatedAt = FakeClock.BaseNow,
            };
            db.Add(ws);
            var set = new LoggedSet
            {
                Id = Guid.NewGuid(), SessionId = ws.Id, ExerciseId = _app.ExerciseA_SquatId,
                ProgramDayExerciseId = pId, SetNumber = 1, WeightKg = 100m, Reps = 8,
                LoggedAt = FakeClock.BaseNow,
            };
            db.Add(set);
            db.SaveChanges();
            return set.Id;
        });

        var response = await SendAsync(HttpMethod.Delete, $"/api/day-exercises/{pId}", session);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        var loggedSet = _app.WithDb(db =>
            db.LoggedSetsForTrainer(_app.TrainerAId).AsNoTracking().Single(s => s.Id == loggedSetId));
        // database.md principle 4: history keyed by its always-set exercise_id survives
        // prescription deletion; the SET NULL FK is what makes that work.
        Assert.Null(loggedSet.ProgramDayExerciseId);
        Assert.Equal(_app.ExerciseA_SquatId, loggedSet.ExerciseId);
    }

    [Fact]
    public async Task Delete_prescription_of_another_trainer_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var otherPrescriptionId = _app.WithDb(db =>
        {
            var d = new ProgramDay
            {
                Id = Guid.NewGuid(), ProgramId = _app.ProgramBId, Title = "B Day", Position = 1,
            };
            db.Add(d);
            var e = new ProgramDayExercise
            {
                Id = Guid.NewGuid(), ProgramDayId = d.Id, ExerciseId = _app.ExerciseBId,
                Position = 1, TargetSets = 3, TargetReps = "5",
            };
            db.Add(e);
            db.SaveChanges();
            return e.Id;
        });

        var response = await SendAsync(HttpMethod.Delete, $"/api/day-exercises/{otherPrescriptionId}", session);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.NotNull(_app.WithDb(db => db.Find<ProgramDayExercise>(otherPrescriptionId)));
    }

    // -- PATCH /api/days/:id/order (the reorder AC) --

    [Fact]
    public async Task Reorder_rewrites_positions_1_through_n_in_one_transaction()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Reorderable");

        var p1 = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);
        var p2 = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_BenchId);

        // Reverse the order.
        var response = await SendAsync(HttpMethod.Patch, $"/api/days/{dayId}/order", session, new
        {
            orderedIds = new[] { p2, p1 },
        });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        var positions = _app.WithDb(db => db.ProgramDayExercisesForTrainer(_app.TrainerAId)
            .Where(e => e.ProgramDayId == dayId)
            .OrderBy(e => e.Position)
            .Select(e => new { e.Id, e.Position })
            .ToList());

        Assert.Equal([(p2, 1), (p1, 2)], positions.Select(p => (p.Id, p.Position)).ToList());
    }

    [Fact]
    public async Task Reorder_rejects_missing_or_extra_ids()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Strict Reorder");
        var p1 = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);
        var p2 = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_BenchId);

        var missing = await SendAsync(HttpMethod.Patch, $"/api/days/{dayId}/order", session, new
        {
            orderedIds = new[] { p1 },
        });
        var extra = await SendAsync(HttpMethod.Patch, $"/api/days/{dayId}/order", session, new
        {
            orderedIds = new[] { p1, p2, Guid.NewGuid() },
        });

        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, extra.StatusCode);

        // Positions unchanged after the two rejected reorders.
        var positions = _app.WithDb(db => db.ProgramDayExercisesForTrainer(_app.TrainerAId)
            .Where(e => e.ProgramDayId == dayId)
            .OrderBy(e => e.Position)
            .Select(e => new { e.Id, e.Position })
            .ToList());
        Assert.Equal([(p1, 1), (p2, 2)], positions.Select(p => (p.Id, p.Position)).ToList());
    }

    [Fact]
    public async Task Reorder_rejects_duplicate_ids()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "No Dup");
        var p1 = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);
        _ = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_BenchId);

        var response = await SendAsync(HttpMethod.Patch, $"/api/days/{dayId}/order", session, new
        {
            orderedIds = new[] { p1, p1 },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Reorder_of_another_trainers_day_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var (otherDayId, otherPrescriptionId) = _app.WithDb(db =>
        {
            var d = new ProgramDay
            {
                Id = Guid.NewGuid(), ProgramId = _app.ProgramBId, Title = "B Day", Position = 1,
            };
            db.Add(d);
            var e = new ProgramDayExercise
            {
                Id = Guid.NewGuid(), ProgramDayId = d.Id, ExerciseId = _app.ExerciseBId,
                Position = 1, TargetSets = 3, TargetReps = "5",
            };
            db.Add(e);
            db.SaveChanges();
            return (d.Id, e.Id);
        });

        var response = await SendAsync(HttpMethod.Patch, $"/api/days/{otherDayId}/order", session, new
        {
            orderedIds = new[] { otherPrescriptionId },
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- Free-text sanity check on target_reps and target_load (#99 follow-up) --
    //
    // The rules and their boundary live in PrescriptionTextTests, against a corpus shared with
    // the SPA. These assert only that the endpoints actually apply them, on both fields and on
    // both write paths — the guard exists here precisely because a browser-only one is a
    // property of one browser rather than of the data.

    [Theory]
    [InlineData("AMRKJDNAK,M", "8-10")]
    [InlineData("8-10", "70 lbsgjhm")]
    public async Task Create_refuses_gibberish_in_either_free_text_field(string reps, string load)
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Lower");

        var response = await SendAsync(HttpMethod.Post, $"/api/days/{dayId}/exercises", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            targetSets = 3,
            targetReps = reps,
            targetLoad = load,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("bad_request", body.GetProperty("error").GetProperty("code").GetString());

        // Nothing was written: a refused prescription must not leave half a row behind.
        Assert.Empty(_app.WithDb(db => db.ProgramDayExercisesForTrainer(_app.TrainerAId)
            .Where(e => e.ProgramDayId == dayId)
            .ToList()));
    }

    [Theory]
    [InlineData("AMRKJDNAK,M", null)]
    [InlineData(null, "70 lbsgjhm")]
    public async Task Patch_refuses_gibberish_in_either_free_text_field(string? reps, string? load)
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Lower");
        var prescriptionId = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);

        var response = await SendAsync(
            HttpMethod.Patch, $"/api/day-exercises/{prescriptionId}", session,
            new { targetReps = reps, targetLoad = load });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        // The row is untouched — the check runs before anything is assigned.
        var stored = _app.WithDb(db => db.ProgramDayExercisesForTrainer(_app.TrainerAId)
            .First(e => e.Id == prescriptionId));
        Assert.Equal("8-10", stored.TargetReps);
        Assert.Null(stored.TargetLoad);
    }

    [Fact]
    public async Task Still_stores_free_text_verbatim_on_both_fields()
    {
        // database.md's decision is intact: the endpoint understands neither field and converts
        // neither. These are stored exactly as written.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Lower");

        var response = await SendAsync(HttpMethod.Post, $"/api/days/{dayId}/exercises", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            targetSets = 3,
            targetReps = "AMRAP -2",
            targetLoad = "top set + backoffs",
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("AMRAP -2", body.GetProperty("targetReps").GetString());
        Assert.Equal("top set + backoffs", body.GetProperty("targetLoad").GetString());
    }

    [Fact]
    public async Task Patch_leaves_a_field_the_body_does_not_carry_unchecked()
    {
        // null on the wire means "leave alone", so an absent field is not re-validated. A row
        // that predates this check keeps saving as long as the trainer is not editing the part
        // that would now be refused.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var dayId = await CreateDayAsync(session, _app.ProgramAId, "Lower");
        var prescriptionId = await CreatePrescriptionAsync(session, dayId, _app.ExerciseA_SquatId);

        _app.WithDb(db =>
        {
            db.ProgramDayExercisesForTrainer(_app.TrainerAId).First(e => e.Id == prescriptionId)
                .TargetLoad = "70 lbsgjhm";
            db.SaveChanges();
        });

        var response = await SendAsync(
            HttpMethod.Patch, $"/api/day-exercises/{prescriptionId}", session, new { targetSets = 5 });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
