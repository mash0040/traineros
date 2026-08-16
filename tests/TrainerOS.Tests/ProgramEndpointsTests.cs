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

// The Api project's top-level `Program` class collides with the entity type in this
// namespace; alias to disambiguate.
using ProgramEntity = TrainerOS.Domain.Entities.Program;

namespace TrainerOS.Tests;

// Two tenants (trainer A with clients A1/A2, trainer B with client B1) inside a shared
// SQLite fixture. The 409 AC ("backed by the partial unique index") only means anything
// if the DB actually creates that index — EF Core carries HasFilter("status = 'active'")
// through to SQLite, so this fixture exercises the real constraint, not app-side logic.
public sealed class ProgramEndpointsTestApp : IAsyncLifetime
{
    private readonly string _connectionString =
        $"Data Source=program-tests-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";

    private WebApplication _app = null!;
    private SqliteConnection _keepAlive = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;

    public Guid TrainerAId { get; } = Guid.NewGuid();
    public Guid TrainerBId { get; } = Guid.NewGuid();
    public Guid ClientA1Id { get; } = Guid.NewGuid();
    public Guid ClientA2Id { get; } = Guid.NewGuid();
    public Guid ClientB1Id { get; } = Guid.NewGuid();

    // Seed programs kept minimal — the 409 tests need to create their own so they can
    // control which client already has an active program without cross-test coupling.
    public Guid ProgramA_Draft_Id { get; } = Guid.NewGuid();
    public Guid ProgramB_Active_Id { get; } = Guid.NewGuid();

    // One exercise, for the delete tests (#118): a prescription and a logged set both carry a
    // RESTRICT foreign key to exercises, so neither can be seeded without a row to point at.
    public Guid ExerciseAId { get; } = Guid.NewGuid();

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
        _app.MapGroup("/api").MapProgramEndpoints();

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
                Id = ClientA2Id, Role = Roles.Client, Email = "bob@example.com",
                DisplayName = "Bob", TrainerId = TrainerAId, Timezone = "America/Toronto",
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
                Id = ProgramA_Draft_Id, TrainerId = TrainerAId, ClientId = ClientA1Id,
                Title = "Hypertrophy Draft", Status = ProgramStatuses.Draft,
                CreatedAt = Clock.Now, UpdatedAt = Clock.Now,
            });
            // Cross-tenant fixture: trainer B has a program that must not appear in
            // trainer A's list or become fetchable/patchable through A's session.
            db.Add(new ProgramEntity
            {
                Id = ProgramB_Active_Id, TrainerId = TrainerBId, ClientId = ClientB1Id,
                Title = "B's Block", Status = ProgramStatuses.Active,
                CreatedAt = Clock.Now, UpdatedAt = Clock.Now,
            });

            db.Add(new Exercise
            {
                Id = ExerciseAId, TrainerId = TrainerAId, Name = "Back Squat",
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

public class ProgramEndpointsTests : IClassFixture<ProgramEndpointsTestApp>
{
    private readonly ProgramEndpointsTestApp _app;

    public ProgramEndpointsTests(ProgramEndpointsTestApp app)
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

    private async Task<Guid> CreateProgramAsync(
        Guid session, Guid clientId, string title, string status = ProgramStatuses.Draft)
    {
        var response = await SendAsync(HttpMethod.Post, "/api/programs", session, new
        {
            clientId, title, status,
            startsOn = (DateOnly?)null,
            notes = (string?)null,
        });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("id").GetGuid();
    }

    // -- Role gating --

    [Fact]
    public async Task Anonymous_list_is_401()
    {
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/programs", null));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Client_role_list_is_404_not_403()
    {
        var session = await _app.SignInAsync(_app.ClientA1Id);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/programs", session));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- GET /api/programs --

    [Fact]
    public async Task Trainer_lists_only_own_programs()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/programs", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var ids = body.EnumerateArray().Select(e => e.GetProperty("id").GetGuid()).ToHashSet();

        Assert.Contains(_app.ProgramA_Draft_Id, ids);
        Assert.DoesNotContain(_app.ProgramB_Active_Id, ids);
    }

    // -- POST /api/programs --

    [Fact]
    public async Task Trainer_creates_program_as_draft_by_default()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/programs", session, new
        {
            clientId = _app.ClientA2Id,
            title = "New Block",
            status = (string?)null,
            startsOn = (DateOnly?)null,
            notes = "  ",
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var newId = body.GetProperty("id").GetGuid();

        Assert.Equal(_app.ClientA2Id, body.GetProperty("clientId").GetGuid());
        Assert.Equal("New Block", body.GetProperty("title").GetString());
        Assert.Equal(ProgramStatuses.Draft, body.GetProperty("status").GetString());

        var persisted = _app.WithDb(db =>
            db.ProgramsForTrainer(_app.TrainerAId).AsNoTracking().Single(p => p.Id == newId));
        Assert.Equal(_app.TrainerAId, persisted.TrainerId);
        Assert.Null(persisted.Notes); // blank collapsed to NULL
    }

    [Fact]
    public async Task Trainer_can_create_active_program_when_client_has_no_active()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/programs", session, new
        {
            clientId = _app.ClientA2Id,
            title = "Direct Active",
            status = ProgramStatuses.Active,
            startsOn = new DateOnly(2026, 8, 1),
            notes = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    // The AC's marquee test: creating a second active program → 409 from the DB index.
    [Fact]
    public async Task Creating_second_active_program_for_same_client_is_409()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var clientId = _app.WithDb(db =>
        {
            var u = new User
            {
                Id = Guid.NewGuid(), Role = Roles.Client, Email = $"dupe-{Guid.NewGuid():N}@example.com",
                DisplayName = "Dupe", TrainerId = _app.TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = FakeClock.BaseNow,
            };
            db.Add(u);
            db.SaveChanges();
            return u.Id;
        });

        var first = await CreateProgramAsync(session, clientId, "First Active", ProgramStatuses.Active);
        Assert.NotEqual(Guid.Empty, first);

        var conflict = await SendAsync(HttpMethod.Post, "/api/programs", session, new
        {
            clientId,
            title = "Second Active",
            status = ProgramStatuses.Active,
            startsOn = (DateOnly?)null,
            notes = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        var body = await conflict.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("program_active_conflict", body.GetProperty("error").GetProperty("code").GetString());

        // Only the first active row exists — the second was rejected by the constraint,
        // not silently accepted.
        var activeCount = _app.WithDb(db => db.ProgramsForTrainer(_app.TrainerAId)
            .Count(p => p.ClientId == clientId && p.Status == ProgramStatuses.Active));
        Assert.Equal(1, activeCount);
    }

    [Fact]
    public async Task Creating_second_active_program_across_clients_is_allowed()
    {
        // The partial unique index is per-client, not per-trainer: two different clients
        // may each have their own active program.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var c1 = _app.WithDb(db =>
        {
            var u = new User
            {
                Id = Guid.NewGuid(), Role = Roles.Client, Email = $"c1-{Guid.NewGuid():N}@example.com",
                DisplayName = "C1", TrainerId = _app.TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = FakeClock.BaseNow,
            };
            db.Add(u);
            db.SaveChanges();
            return u.Id;
        });
        var c2 = _app.WithDb(db =>
        {
            var u = new User
            {
                Id = Guid.NewGuid(), Role = Roles.Client, Email = $"c2-{Guid.NewGuid():N}@example.com",
                DisplayName = "C2", TrainerId = _app.TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = FakeClock.BaseNow,
            };
            db.Add(u);
            db.SaveChanges();
            return u.Id;
        });

        await CreateProgramAsync(session, c1, "P1", ProgramStatuses.Active);
        await CreateProgramAsync(session, c2, "P2", ProgramStatuses.Active);
    }

    [Theory]
    [InlineData(null, "Title")]
    [InlineData("", "Title")]
    [InlineData("   ", "Title")]
    public async Task Create_rejects_missing_or_blank_title(string? title, string _)
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/programs", session, new
        {
            clientId = _app.ClientA1Id,
            title,
            status = (string?)null,
            startsOn = (DateOnly?)null,
            notes = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Create_rejects_missing_client_id()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/programs", session, new
        {
            clientId = (Guid?)null,
            title = "Anon",
            status = (string?)null,
            startsOn = (DateOnly?)null,
            notes = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Create_rejects_invalid_status()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/programs", session, new
        {
            clientId = _app.ClientA1Id,
            title = "Weird",
            status = "paused",
            startsOn = (DateOnly?)null,
            notes = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Create_for_another_trainers_client_is_unknown_client()
    {
        // conventions.md §Isolation: a trainer naming another trainer's client id gets
        // the same rejection as a made-up id — no cross-tenant existence oracle.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var crossTenant = await SendAsync(HttpMethod.Post, "/api/programs", session, new
        {
            clientId = _app.ClientB1Id,
            title = "Hijack",
            status = (string?)null,
            startsOn = (DateOnly?)null,
            notes = (string?)null,
        });
        var madeUp = await SendAsync(HttpMethod.Post, "/api/programs", session, new
        {
            clientId = Guid.NewGuid(),
            title = "Ghost",
            status = (string?)null,
            startsOn = (DateOnly?)null,
            notes = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, crossTenant.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, madeUp.StatusCode);
        Assert.Equal(
            "unknown_client",
            (await crossTenant.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(
            "unknown_client",
            (await madeUp.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Create_rejects_unknown_body_fields()
    {
        // api.md §Cross-cutting: unknown fields rejected, not ignored.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/programs", session, new
        {
            clientId = _app.ClientA1Id,
            title = "Sneaky",
            trainerId = Guid.NewGuid(), // attempt to redirect ownership
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // -- GET /api/programs/:id --

    [Fact]
    public async Task Get_by_id_returns_own_program()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/programs/{_app.ProgramA_Draft_Id}", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(_app.ProgramA_Draft_Id, body.GetProperty("id").GetGuid());
        Assert.Equal("Hypertrophy Draft", body.GetProperty("title").GetString());
    }

    [Fact]
    public async Task Get_by_id_for_other_trainers_program_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/programs/{_app.ProgramB_Active_Id}", session));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- GET /api/programs/:id, the nested tree (#78) --

    // Seeds two days and three prescriptions onto a program, all inserted in the wrong order
    // so the endpoint's OrderBy is the only thing that can produce the right one. Insertion
    // order is not sort order and SQLite is happy to hand rows back either way.
    private (Guid DayOne, Guid DayTwo, Guid Squat, Guid Bench) SeedTree(Guid programId, Guid trainerId)
    {
        var dayOne = Guid.NewGuid();
        var dayTwo = Guid.NewGuid();
        var squat = Guid.NewGuid();
        var bench = Guid.NewGuid();

        _app.WithDb(db =>
        {
            db.Add(new Exercise
            {
                Id = squat, TrainerId = trainerId, Name = "Back Squat",
                VideoUrl = "https://youtube.com/watch?v=squat", Cues = "Knees track over toes.",
                IsActive = true, CreatedAt = FakeClock.BaseNow,
            });
            db.Add(new Exercise
            {
                Id = bench, TrainerId = trainerId, Name = "Bench Press",
                IsActive = true, CreatedAt = FakeClock.BaseNow,
            });

            // Day 2 inserted first.
            db.Add(new ProgramDay { Id = dayTwo, ProgramId = programId, Title = "Upper", Position = 2 });
            db.Add(new ProgramDay { Id = dayOne, ProgramId = programId, Title = "Lower", Position = 1 });

            // Position 2 inserted before position 1 within the same day.
            db.Add(new ProgramDayExercise
            {
                Id = Guid.NewGuid(), ProgramDayId = dayOne, ExerciseId = bench, Position = 2,
                TargetSets = 4, TargetReps = "5",
            });
            db.Add(new ProgramDayExercise
            {
                Id = Guid.NewGuid(), ProgramDayId = dayOne, ExerciseId = squat, Position = 1,
                TargetSets = 3, TargetReps = "8-10", TargetLoad = "70 kg", RestSeconds = 90,
                Note = "Brace before you unrack.",
            });
            db.Add(new ProgramDayExercise
            {
                Id = Guid.NewGuid(), ProgramDayId = dayTwo, ExerciseId = bench, Position = 1,
                TargetSets = 5, TargetReps = "3",
            });

            db.SaveChanges();
        });

        return (dayOne, dayTwo, squat, bench);
    }

    [Fact]
    public async Task Get_by_id_returns_days_and_prescriptions_ordered_by_position()
    {
        // The read the program builder (#52) is blocked on: one request, whole tree, in the
        // order the trainer arranged it.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var programId = await CreateProgramAsync(session, _app.ClientA2Id, "Tree");
        var seeded = SeedTree(programId, _app.TrainerAId);

        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/programs/{programId}", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        // The program node still carries what it always did — this is an enrichment, not a
        // replacement, and the builder reads client_id and status off the same response.
        Assert.Equal(programId, body.GetProperty("id").GetGuid());
        Assert.Equal(_app.ClientA2Id, body.GetProperty("clientId").GetGuid());
        Assert.Equal("Tree", body.GetProperty("title").GetString());
        Assert.Equal(ProgramStatuses.Draft, body.GetProperty("status").GetString());

        var days = body.GetProperty("days").EnumerateArray().ToList();
        Assert.Equal(2, days.Count);
        Assert.Equal(seeded.DayOne, days[0].GetProperty("id").GetGuid());
        Assert.Equal("Lower", days[0].GetProperty("title").GetString());
        Assert.Equal(seeded.DayTwo, days[1].GetProperty("id").GetGuid());

        var lower = days[0].GetProperty("prescriptions").EnumerateArray().ToList();
        Assert.Equal(2, lower.Count);
        Assert.Equal(1, lower[0].GetProperty("position").GetInt32());
        Assert.Equal(2, lower[1].GetProperty("position").GetInt32());

        // Every prescription carries the exercise it names, so the builder never fans out to
        // resolve a name it is about to render.
        var first = lower[0];
        Assert.Equal(3, first.GetProperty("targetSets").GetInt32());
        Assert.Equal("8-10", first.GetProperty("targetReps").GetString());
        Assert.Equal("70 kg", first.GetProperty("targetLoad").GetString());
        Assert.Equal(90, first.GetProperty("restSeconds").GetInt32());
        Assert.Equal("Brace before you unrack.", first.GetProperty("note").GetString());

        var exercise = first.GetProperty("exercise");
        Assert.Equal(seeded.Squat, exercise.GetProperty("id").GetGuid());
        Assert.Equal("Back Squat", exercise.GetProperty("name").GetString());
        Assert.Equal("https://youtube.com/watch?v=squat", exercise.GetProperty("videoUrl").GetString());
        Assert.Equal("Knees track over toes.", exercise.GetProperty("cues").GetString());

        // A day's prescriptions are its own: the bench row on day 2 does not appear under day 1
        // just because the same exercise is prescribed in both.
        var upper = days[1].GetProperty("prescriptions").EnumerateArray().ToList();
        Assert.Single(upper);
        Assert.Equal(5, upper[0].GetProperty("targetSets").GetInt32());
    }

    [Fact]
    public async Task Get_by_id_returns_an_empty_day_list_for_a_program_with_no_structure()
    {
        // A program the trainer has created and not filled in yet. Empty array, not null and
        // not a 404 — the builder's empty state is an ordinary render, same as #30's.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var programId = await CreateProgramAsync(session, _app.ClientA2Id, "Shell Only");

        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/programs/{programId}", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Array, body.GetProperty("days").ValueKind);
        Assert.Empty(body.GetProperty("days").EnumerateArray());
    }

    [Fact]
    public async Task Get_by_id_renders_a_prescription_whose_exercise_was_soft_deleted()
    {
        // api.md: deleting an exercise is PATCH is_active=false, and prescriptions written
        // before that keep pointing at it. The exercise fetch deliberately does not filter
        // is_active — if it did, the dictionary lookup building the response would throw and
        // the whole program would 500 on the one screen the trainer needs to fix it from.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var programId = await CreateProgramAsync(session, _app.ClientA2Id, "Retired Movement");
        var dayId = Guid.NewGuid();
        var retiredId = Guid.NewGuid();

        _app.WithDb(db =>
        {
            db.Add(new Exercise
            {
                Id = retiredId, TrainerId = _app.TrainerAId, Name = "Sissy Squat",
                IsActive = false, CreatedAt = FakeClock.BaseNow,
            });
            db.Add(new ProgramDay { Id = dayId, ProgramId = programId, Title = "Legs", Position = 1 });
            db.Add(new ProgramDayExercise
            {
                Id = Guid.NewGuid(), ProgramDayId = dayId, ExerciseId = retiredId, Position = 1,
                TargetSets = 3, TargetReps = "12",
            });
            db.SaveChanges();
        });

        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/programs/{programId}", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var prescription = body.GetProperty("days").EnumerateArray().Single()
            .GetProperty("prescriptions").EnumerateArray().Single();
        Assert.Equal("Sissy Squat", prescription.GetProperty("exercise").GetProperty("name").GetString());
    }

    [Fact]
    public async Task Get_by_id_does_not_expose_another_trainers_tree()
    {
        // conventions.md §Isolation, applied to the enriched payload rather than only to the
        // shell it replaced: the days and prescriptions are new data on this route, so the
        // 404 is re-proven with a tree actually present to leak.
        SeedTree(_app.ProgramB_Active_Id, _app.TrainerBId);

        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/programs/{_app.ProgramB_Active_Id}", session));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var payload = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("Back Squat", payload);
        Assert.DoesNotContain("Lower", payload);
    }

    [Fact]
    public async Task Get_nonexistent_id_is_404_indistinguishable_from_cross_tenant()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var made = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/programs/{Guid.NewGuid()}", session));
        var other = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/programs/{_app.ProgramB_Active_Id}", session));

        Assert.Equal(HttpStatusCode.NotFound, made.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, other.StatusCode);
        Assert.Equal(
            await made.Content.ReadAsStringAsync(),
            await other.Content.ReadAsStringAsync());
    }

    // -- PATCH /api/programs/:id --

    [Fact]
    public async Task Patch_updates_title_and_notes_and_bumps_updated_at()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var id = await CreateProgramAsync(session, _app.ClientA2Id, "Original");

        _app.Clock.Now = FakeClock.BaseNow.AddHours(1);

        var response = await SendAsync(HttpMethod.Patch, $"/api/programs/{id}", session, new
        {
            title = "Renamed",
            notes = "some notes",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ProgramsForTrainer(_app.TrainerAId).AsNoTracking().Single(p => p.Id == id));
        Assert.Equal("Renamed", persisted.Title);
        Assert.Equal("some notes", persisted.Notes);
        Assert.Equal(FakeClock.BaseNow.AddHours(1), persisted.UpdatedAt);
    }

    [Fact]
    public async Task Patch_status_draft_to_active_succeeds_when_client_has_no_active()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var clientId = _app.WithDb(db =>
        {
            var u = new User
            {
                Id = Guid.NewGuid(), Role = Roles.Client, Email = $"transition-{Guid.NewGuid():N}@example.com",
                DisplayName = "T", TrainerId = _app.TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = FakeClock.BaseNow,
            };
            db.Add(u);
            db.SaveChanges();
            return u.Id;
        });
        var id = await CreateProgramAsync(session, clientId, "Draft to Active");

        var response = await SendAsync(HttpMethod.Patch, $"/api/programs/{id}", session, new
        {
            status = ProgramStatuses.Active,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    // The other half of the AC's 409 — an activation via PATCH must also 409 when the
    // client already has an active program.
    [Fact]
    public async Task Patch_activating_second_program_for_same_client_is_409()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var clientId = _app.WithDb(db =>
        {
            var u = new User
            {
                Id = Guid.NewGuid(), Role = Roles.Client, Email = $"switch-{Guid.NewGuid():N}@example.com",
                DisplayName = "S", TrainerId = _app.TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = FakeClock.BaseNow,
            };
            db.Add(u);
            db.SaveChanges();
            return u.Id;
        });
        await CreateProgramAsync(session, clientId, "The Active", ProgramStatuses.Active);
        var draftId = await CreateProgramAsync(session, clientId, "The Draft");

        var response = await SendAsync(HttpMethod.Patch, $"/api/programs/{draftId}", session, new
        {
            status = ProgramStatuses.Active,
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("program_active_conflict", body.GetProperty("error").GetProperty("code").GetString());

        var persisted = _app.WithDb(db =>
            db.ProgramsForTrainer(_app.TrainerAId).AsNoTracking().Single(p => p.Id == draftId));
        Assert.Equal(ProgramStatuses.Draft, persisted.Status);
    }

    [Fact]
    public async Task Patch_archiving_the_active_frees_the_slot_for_another()
    {
        // Transitions loop end-to-end: archive → the partial index no longer covers the
        // old row, so a second program can now become active.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var clientId = _app.WithDb(db =>
        {
            var u = new User
            {
                Id = Guid.NewGuid(), Role = Roles.Client, Email = $"handoff-{Guid.NewGuid():N}@example.com",
                DisplayName = "H", TrainerId = _app.TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = FakeClock.BaseNow,
            };
            db.Add(u);
            db.SaveChanges();
            return u.Id;
        });
        var firstActive = await CreateProgramAsync(session, clientId, "Old", ProgramStatuses.Active);
        var successor = await CreateProgramAsync(session, clientId, "New");

        var archive = await SendAsync(HttpMethod.Patch, $"/api/programs/{firstActive}", session, new
        {
            status = ProgramStatuses.Archived,
        });
        Assert.Equal(HttpStatusCode.OK, archive.StatusCode);

        var activate = await SendAsync(HttpMethod.Patch, $"/api/programs/{successor}", session, new
        {
            status = ProgramStatuses.Active,
        });
        Assert.Equal(HttpStatusCode.OK, activate.StatusCode);
    }

    [Fact]
    public async Task Patch_invalid_status_is_400()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/programs/{_app.ProgramA_Draft_Id}", session, new
        {
            status = "paused",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Patch_blank_title_is_400()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/programs/{_app.ProgramA_Draft_Id}", session, new
        {
            title = "   ",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Patch_other_trainers_program_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/programs/{_app.ProgramB_Active_Id}", session, new
        {
            title = "Hijack",
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        var untouched = _app.WithDb(db => db.Find<ProgramEntity>(_app.ProgramB_Active_Id)!);
        Assert.Equal("B's Block", untouched.Title);
    }

    // -- DELETE /api/programs/:id (#118) --

    /// <summary>A day with one prescription on it, so a delete has a tree to take with it.</summary>
    private (Guid DayId, Guid PrescriptionId) SeedDay(Guid programId)
    {
        return _app.WithDb(db =>
        {
            var day = new ProgramDay
            {
                Id = Guid.NewGuid(), ProgramId = programId, Title = "Day A", Position = 1,
            };
            db.Add(day);

            var prescription = new ProgramDayExercise
            {
                Id = Guid.NewGuid(), ProgramDayId = day.Id, ExerciseId = _app.ExerciseAId,
                Position = 1, TargetSets = 3, TargetReps = "8",
            };
            db.Add(prescription);
            db.SaveChanges();

            return (day.Id, prescription.Id);
        });
    }

    private Guid SeedSession(Guid clientId, Guid? programDayId, DateOnly performedOn)
    {
        return _app.WithDb(db =>
        {
            var session = new WorkoutSession
            {
                Id = Guid.NewGuid(), TrainerId = _app.TrainerAId, ClientId = clientId,
                ProgramDayId = programDayId, PerformedOn = performedOn, CreatedAt = FakeClock.BaseNow,
            };
            db.Add(session);
            db.SaveChanges();
            return session.Id;
        });
    }

    private void SeedSet(Guid sessionId, Guid? prescriptionId)
    {
        _app.WithDb(db =>
        {
            db.Add(new LoggedSet
            {
                Id = Guid.NewGuid(), SessionId = sessionId, ExerciseId = _app.ExerciseAId,
                ProgramDayExerciseId = prescriptionId, SetNumber = 1, WeightKg = 60m, Reps = 8,
                LoggedAt = FakeClock.BaseNow,
            });
            db.SaveChanges();
        });
    }

    [Fact]
    public async Task Anonymous_delete_is_401()
    {
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Delete, $"/api/programs/{_app.ProgramA_Draft_Id}", null));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.NotNull(_app.WithDb(db => db.Find<ProgramEntity>(_app.ProgramA_Draft_Id)));
    }

    [Fact]
    public async Task Client_role_delete_is_404_not_403()
    {
        var session = await _app.SignInAsync(_app.ClientA1Id);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Delete, $"/api/programs/{_app.ProgramA_Draft_Id}", session));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.NotNull(_app.WithDb(db => db.Find<ProgramEntity>(_app.ProgramA_Draft_Id)));
    }

    [Fact]
    public async Task Delete_removes_an_untrained_program_and_its_tree()
    {
        // The case the endpoint exists for: built by mistake, never trained against, and until
        // now with no way out of the client's list.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var programId = await CreateProgramAsync(session, _app.ClientA1Id, "Typo Block");
        var (dayId, prescriptionId) = SeedDay(programId);

        var response = await SendAsync(HttpMethod.Delete, $"/api/programs/{programId}", session);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        // The days cascade and their prescriptions cascade from those, so the tree goes with the
        // program rather than being left as rows nothing can reach.
        Assert.Null(_app.WithDb(db => db.Find<ProgramEntity>(programId)));
        Assert.Null(_app.WithDb(db => db.Find<ProgramDay>(dayId)));
        Assert.Null(_app.WithDb(db => db.Find<ProgramDayExercise>(prescriptionId)));
    }

    [Fact]
    public async Task Delete_twice_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var programId = await CreateProgramAsync(session, _app.ClientA1Id, "Gone");

        var first = await SendAsync(HttpMethod.Delete, $"/api/programs/{programId}", session);
        var second = await SendAsync(HttpMethod.Delete, $"/api/programs/{programId}", session);

        Assert.Equal(HttpStatusCode.NoContent, first.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, second.StatusCode);
    }

    [Fact]
    public async Task Delete_other_trainers_program_is_the_same_404_as_a_fabricated_id()
    {
        // conventions.md §Isolation. The point is not only the status code: the two bodies are
        // compared as strings, so nothing in the response can tell trainer A that trainer B's
        // program is a real row while the made-up id is not.
        var session = await _app.SignInAsync(_app.TrainerAId);

        var crossTenant = await SendAsync(
            HttpMethod.Delete, $"/api/programs/{_app.ProgramB_Active_Id}", session);
        var fabricated = await SendAsync(
            HttpMethod.Delete, $"/api/programs/{Guid.NewGuid()}", session);

        Assert.Equal(HttpStatusCode.NotFound, crossTenant.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, fabricated.StatusCode);
        Assert.Equal(
            await fabricated.Content.ReadAsStringAsync(),
            await crossTenant.Content.ReadAsStringAsync());

        var untouched = _app.WithDb(db => db.Find<ProgramEntity>(_app.ProgramB_Active_Id)!);
        Assert.Equal("B's Block", untouched.Title);
    }

    [Fact]
    public async Task Delete_refuses_when_a_session_references_one_of_its_days()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var programId = await CreateProgramAsync(session, _app.ClientA2Id, "Trained Block");
        var (dayId, _) = SeedDay(programId);
        var sessionId = SeedSession(_app.ClientA2Id, dayId, new DateOnly(2026, 7, 20));

        var response = await SendAsync(HttpMethod.Delete, $"/api/programs/{programId}", session);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var error = body.GetProperty("error");
        Assert.Equal("program_has_history", error.GetProperty("code").GetString());
        // The refusal names the reason and the way out, which is the whole reason it is a message
        // rather than a bare status code.
        var message = error.GetProperty("message").GetString()!;
        Assert.Contains("logged workouts", message);
        Assert.Contains("Archive", message);

        // Nothing was taken: neither the program nor the history that blocked it.
        Assert.NotNull(_app.WithDb(db => db.Find<ProgramEntity>(programId)));
        Assert.NotNull(_app.WithDb(db => db.Find<ProgramDay>(dayId)));
        Assert.Equal(dayId, _app.WithDb(db => db.Find<WorkoutSession>(sessionId)!.ProgramDayId));
    }

    [Fact]
    public async Task Delete_refuses_when_only_a_logged_set_references_a_prescription()
    {
        // The gap the AC's original wording left open. POST /api/me/sessions/:id/sets validates
        // program_day_exercise_id against the client's whole library of programs rather than
        // against the session's own day, so a set can name this program's prescription while its
        // session names no day at all. Checking sessions alone would have deleted the program and
        // cut this set loose.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var programId = await CreateProgramAsync(session, _app.ClientA2Id, "Freestyle Block");
        var (_, prescriptionId) = SeedDay(programId);
        var freestyle = SeedSession(_app.ClientA2Id, null, new DateOnly(2026, 7, 21));
        SeedSet(freestyle, prescriptionId);

        var response = await SendAsync(HttpMethod.Delete, $"/api/programs/{programId}", session);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var error = body.GetProperty("error");
        Assert.Equal("program_has_history", error.GetProperty("code").GetString());
        // Says sets rather than workouts, because no session names a day of this program and
        // claiming otherwise would send the trainer looking for something not in the history.
        var message = error.GetProperty("message").GetString()!;
        Assert.Contains("logged sets", message);
        Assert.Contains("Archive", message);

        Assert.NotNull(_app.WithDb(db => db.Find<ProgramEntity>(programId)));
        Assert.NotNull(_app.WithDb(db => db.Find<ProgramDayExercise>(prescriptionId)));
    }

    [Fact]
    public async Task Delete_allows_an_untrained_program_while_another_has_history()
    {
        // The check on the check: history belongs to the program it was logged against, so a
        // WHERE clause that forgot to name this program would fail here rather than in production.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var trained = await CreateProgramAsync(session, _app.ClientA2Id, "Trained Neighbour");
        var (trainedDayId, trainedPrescriptionId) = SeedDay(trained);
        var sessionId = SeedSession(_app.ClientA2Id, trainedDayId, new DateOnly(2026, 7, 22));
        SeedSet(sessionId, trainedPrescriptionId);

        var untrained = await CreateProgramAsync(session, _app.ClientA2Id, "Untrained Neighbour");
        SeedDay(untrained);

        var response = await SendAsync(HttpMethod.Delete, $"/api/programs/{untrained}", session);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Null(_app.WithDb(db => db.Find<ProgramEntity>(untrained)));
        Assert.NotNull(_app.WithDb(db => db.Find<ProgramEntity>(trained)));
    }
}
