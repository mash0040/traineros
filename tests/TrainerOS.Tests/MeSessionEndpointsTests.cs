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

// Two tenants each with a client, a program, a day, a prescription, and (for the
// nested-ownership isolation AC) a pre-seeded workout session. Client A must never
// be able to POST a set through client B's session id — that's the core AC test.
public sealed class MeSessionEndpointsTestApp : IAsyncLifetime
{
    private readonly string _connectionString =
        $"Data Source=me-sessions-tests-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";

    private WebApplication _app = null!;
    private SqliteConnection _keepAlive = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;

    public Guid TrainerAId { get; } = Guid.NewGuid();
    public Guid TrainerBId { get; } = Guid.NewGuid();
    public Guid ClientAId { get; } = Guid.NewGuid();
    public Guid ClientBId { get; } = Guid.NewGuid();

    public Guid ProgramAId { get; } = Guid.NewGuid();
    public Guid ProgramBId { get; } = Guid.NewGuid();
    public Guid DayAId { get; } = Guid.NewGuid();
    public Guid DayBId { get; } = Guid.NewGuid();
    public Guid RxAId { get; } = Guid.NewGuid();
    public Guid RxBId { get; } = Guid.NewGuid();

    public Guid ExerciseA_SquatId { get; } = Guid.NewGuid();
    public Guid ExerciseA_InactiveId { get; } = Guid.NewGuid();
    public Guid ExerciseBId { get; } = Guid.NewGuid();

    public Guid SessionB_Id { get; } = Guid.NewGuid();

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
                Id = ExerciseA_SquatId, TrainerId = TrainerAId, Name = "Squat",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseA_InactiveId, TrainerId = TrainerAId, Name = "Retired Curl",
                IsActive = false, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseBId, TrainerId = TrainerBId, Name = "B's Deadlift",
                IsActive = true, CreatedAt = Clock.Now,
            });

            db.Add(new ProgramEntity
            {
                Id = ProgramAId, TrainerId = TrainerAId, ClientId = ClientAId,
                Title = "A Program", Status = ProgramStatuses.Active,
                CreatedAt = Clock.Now, UpdatedAt = Clock.Now,
            });
            db.Add(new ProgramEntity
            {
                Id = ProgramBId, TrainerId = TrainerBId, ClientId = ClientBId,
                Title = "B Program", Status = ProgramStatuses.Active,
                CreatedAt = Clock.Now, UpdatedAt = Clock.Now,
            });
            db.Add(new ProgramDay { Id = DayAId, ProgramId = ProgramAId, Title = "Day A", Position = 1 });
            db.Add(new ProgramDay { Id = DayBId, ProgramId = ProgramBId, Title = "Day B", Position = 1 });
            db.Add(new ProgramDayExercise
            {
                Id = RxAId, ProgramDayId = DayAId, ExerciseId = ExerciseA_SquatId,
                Position = 1, TargetSets = 3, TargetReps = "8-10",
            });
            db.Add(new ProgramDayExercise
            {
                Id = RxBId, ProgramDayId = DayBId, ExerciseId = ExerciseBId,
                Position = 1, TargetSets = 3, TargetReps = "5",
            });

            // Client B has a pre-existing workout session — client A must not be able
            // to POST a set to it through /me/sessions/{SessionB_Id}/sets.
            db.Add(new WorkoutSession
            {
                Id = SessionB_Id, TrainerId = TrainerBId, ClientId = ClientBId,
                PerformedOn = new DateOnly(2026, 7, 22), CreatedAt = Clock.Now,
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

public class MeSessionEndpointsTests : IClassFixture<MeSessionEndpointsTestApp>
{
    private readonly MeSessionEndpointsTestApp _app;

    public MeSessionEndpointsTests(MeSessionEndpointsTestApp app)
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

    private async Task<Guid> CreateSessionAsync(
        Guid session, Guid? programDayId = null, string? comment = null,
        DateOnly? performedOn = null)
    {
        var response = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn = performedOn ?? new DateOnly(2026, 7, 22),
            programDayId,
            comment,
        });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("id").GetGuid();
    }

    // -- Role gating --

    [Fact]
    public async Task Anonymous_post_session_is_401()
    {
        var request = Request(HttpMethod.Post, "/api/me/sessions", null);
        request.Content = JsonContent.Create(new
        {
            performedOn = new DateOnly(2026, 7, 22),
            programDayId = (Guid?)null,
            comment = (string?)null,
        });
        var response = await _app.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Trainer_role_post_session_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn = new DateOnly(2026, 7, 22),
            programDayId = (Guid?)null,
            comment = (string?)null,
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- POST /api/me/sessions (freestyle) --

    [Fact]
    public async Task Client_creates_freestyle_session_with_null_program_day_id()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn = new DateOnly(2026, 7, 22),
            programDayId = (Guid?)null,
            comment = "shoulder tweak on last set",
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var newId = body.GetProperty("id").GetGuid();

        Assert.Equal("2026-07-22", body.GetProperty("performedOn").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("programDayId").ValueKind);
        Assert.Equal("shoulder tweak on last set", body.GetProperty("comment").GetString());

        var persisted = _app.WithDb(db =>
            db.WorkoutSessionsForClient(_app.ClientAId).AsNoTracking().Single(s => s.Id == newId));
        Assert.Equal(_app.ClientAId, persisted.ClientId);
        Assert.Equal(_app.TrainerAId, persisted.TrainerId); // derived from client.TrainerId
    }

    [Fact]
    public async Task Client_creates_prescribed_session_pointing_at_own_program_day()
    {
        // Its own date. Since #98 a (client, date, program day) triple is one session, so two
        // tests sharing one triple in this class-scoped fixture would make the second resume the
        // first's row and depend on execution order to pass.
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn = new DateOnly(2026, 7, 23),
            programDayId = _app.DayAId,
            comment = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(_app.DayAId, body.GetProperty("programDayId").GetGuid());
    }

    // -- POST /api/me/sessions resume (#98) --

    [Fact]
    public async Task Posting_the_same_day_twice_resumes_the_existing_session()
    {
        // The gym-floor case: she logs Lower, closes the tab or picks up a second device, and
        // the screen posts again. Two rows would split one workout across two, and /api/me/last
        // would answer with half of it.
        var performedOn = new DateOnly(2026, 8, 3);
        var session = await _app.SignInAsync(_app.ClientAId);

        var first = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn,
            programDayId = _app.DayAId,
            comment = "first pass",
        });
        var second = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn,
            programDayId = _app.DayAId,
            comment = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        // 200, not 201: nothing was created. The SPA does not read the status, but the two
        // outcomes are different facts and the code says which happened.
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        var firstBody = await first.Content.ReadFromJsonAsync<JsonElement>();
        var secondBody = await second.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(firstBody.GetProperty("id").GetGuid(), secondBody.GetProperty("id").GetGuid());

        var rows = _app.WithDb(db => db.WorkoutSessionsForClient(_app.ClientAId)
            .AsNoTracking()
            .Count(s => s.PerformedOn == performedOn && s.ProgramDayId == _app.DayAId));
        Assert.Equal(1, rows);
    }

    [Fact]
    public async Task Resuming_does_not_overwrite_the_comment_already_written()
    {
        // The note belongs to the workout, not to the request that happened to arrive second.
        // PATCH /api/me/sessions/:id (#96) is how it gets edited; a create that clobbered it
        // would erase something the client already wrote.
        var performedOn = new DateOnly(2026, 8, 4);
        var session = await _app.SignInAsync(_app.ClientAId);

        await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn, programDayId = _app.DayAId, comment = "shoulder tweaked on OHP",
        });
        var resumed = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn, programDayId = _app.DayAId, comment = (string?)null,
        });

        Assert.Equal(HttpStatusCode.OK, resumed.StatusCode);
        var body = await resumed.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("shoulder tweaked on OHP", body.GetProperty("comment").GetString());
    }

    [Fact]
    public async Task Two_program_days_on_one_calendar_day_are_two_sessions()
    {
        // Day A in the morning, Day B in the evening. A real pattern, and the reason the triple
        // includes program_day_id rather than being one-session-per-client-per-day.
        var performedOn = new DateOnly(2026, 8, 5);
        var clientB = await _app.SignInAsync(_app.ClientBId);

        var morning = await SendAsync(HttpMethod.Post, "/api/me/sessions", clientB, new
        {
            performedOn, programDayId = _app.DayBId, comment = (string?)null,
        });
        var evening = await SendAsync(HttpMethod.Post, "/api/me/sessions", clientB, new
        {
            performedOn, programDayId = (Guid?)null, comment = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Created, morning.StatusCode);
        Assert.Equal(HttpStatusCode.Created, evening.StatusCode);
        Assert.NotEqual(
            (await morning.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid(),
            (await evening.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task Freestyle_sessions_stay_unconstrained()
    {
        // program_day_id NULL is exempt: there is nothing to match on, and Postgres treats NULLs
        // as distinct anyway, so the index is filtered to NOT NULL rather than pretending to
        // cover them. Two freestyle sessions on one day are two workouts.
        var performedOn = new DateOnly(2026, 8, 6);
        var session = await _app.SignInAsync(_app.ClientAId);

        var first = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn, programDayId = (Guid?)null, comment = (string?)null,
        });
        var second = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn, programDayId = (Guid?)null, comment = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        Assert.NotEqual(
            (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid(),
            (await second.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task The_same_day_on_two_calendar_dates_are_two_sessions()
    {
        // Lower on Monday and Lower on Thursday is the ordinary way a program is run. The
        // constraint is per calendar date, not per program day.
        var session = await _app.SignInAsync(_app.ClientAId);

        var monday = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn = new DateOnly(2026, 8, 10), programDayId = _app.DayAId, comment = (string?)null,
        });
        var thursday = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn = new DateOnly(2026, 8, 13), programDayId = _app.DayAId, comment = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Created, monday.StatusCode);
        Assert.Equal(HttpStatusCode.Created, thursday.StatusCode);
    }

    [Fact]
    public async Task Resume_does_not_reach_across_clients()
    {
        // Isolation still holds under the new lookup: the resume query is client-scoped, so
        // client B posting their own day never finds client A's row. Nothing is shared but the
        // date, and that is not an identity.
        var performedOn = new DateOnly(2026, 8, 7);

        var clientA = await _app.SignInAsync(_app.ClientAId);
        var aFirst = await SendAsync(HttpMethod.Post, "/api/me/sessions", clientA, new
        {
            performedOn, programDayId = _app.DayAId, comment = (string?)null,
        });

        var clientB = await _app.SignInAsync(_app.ClientBId);
        var bFirst = await SendAsync(HttpMethod.Post, "/api/me/sessions", clientB, new
        {
            performedOn, programDayId = _app.DayBId, comment = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Created, aFirst.StatusCode);
        Assert.Equal(HttpStatusCode.Created, bFirst.StatusCode);

        var aId = (await aFirst.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var bId = (await bFirst.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.NotEqual(aId, bId);

        // And each client's row stays in their own scope.
        Assert.True(_app.WithDb(db => db.WorkoutSessionsForClient(_app.ClientAId).Any(s => s.Id == aId)));
        Assert.False(_app.WithDb(db => db.WorkoutSessionsForClient(_app.ClientAId).Any(s => s.Id == bId)));
    }

    [Fact]
    public async Task Concurrent_posts_for_one_day_still_yield_one_session()
    {
        // The race the unique index exists for: both requests find nothing, both insert, and
        // the database refuses the second. Without the catch-and-reread the loser would get a
        // 500 for a request that had, in every sense the caller cares about, succeeded.
        var performedOn = new DateOnly(2026, 8, 11);
        var session = await _app.SignInAsync(_app.ClientAId);

        var bodies = Enumerable.Range(0, 4).Select(_ => new
        {
            performedOn, programDayId = _app.DayAId, comment = (string?)null,
        });
        var responses = await Task.WhenAll(bodies.Select(body =>
            SendAsync(HttpMethod.Post, "/api/me/sessions", session, body)));

        Assert.All(responses, response => Assert.True(response.IsSuccessStatusCode,
            $"expected success, got {(int)response.StatusCode}"));

        var ids = new HashSet<Guid>();
        foreach (var response in responses)
        {
            ids.Add((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid());
        }

        Assert.Single(ids);
        var rows = _app.WithDb(db => db.WorkoutSessionsForClient(_app.ClientAId)
            .AsNoTracking()
            .Count(s => s.PerformedOn == performedOn && s.ProgramDayId == _app.DayAId));
        Assert.Equal(1, rows);
    }

    [Fact]
    public async Task Session_with_cross_client_program_day_id_is_400_unknown_program_day()
    {
        // Body-field identity: DayB belongs to client B's program. Client A naming it
        // in their body must get the same 400 as a made-up id (api.md #27).
        var session = await _app.SignInAsync(_app.ClientAId);
        var crossTenant = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn = new DateOnly(2026, 7, 22),
            programDayId = _app.DayBId,
            comment = (string?)null,
        });
        var madeUp = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn = new DateOnly(2026, 7, 22),
            programDayId = Guid.NewGuid(),
            comment = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, crossTenant.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, madeUp.StatusCode);
        Assert.Equal("unknown_program_day",
            (await crossTenant.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("unknown_program_day",
            (await madeUp.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Session_rejects_missing_performed_on()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn = (DateOnly?)null,
            programDayId = (Guid?)null,
            comment = (string?)null,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Session_rejects_unknown_body_fields()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var response = await SendAsync(HttpMethod.Post, "/api/me/sessions", session, new
        {
            performedOn = new DateOnly(2026, 7, 22),
            programDayId = (Guid?)null,
            comment = (string?)null,
            clientId = Guid.NewGuid(), // attempt to redirect ownership
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // -- POST /api/me/sessions/:id/sets (nested ownership) --

    [Fact]
    public async Task Client_logs_a_set_against_own_session()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var workoutId = await CreateSessionAsync(session, programDayId: _app.DayAId);

        var response = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{workoutId}/sets", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            programDayExerciseId = _app.RxAId,
            setNumber = 1,
            weightKg = 100.5m,
            reps = 8,
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var setId = body.GetProperty("id").GetGuid();

        Assert.Equal(workoutId, body.GetProperty("sessionId").GetGuid());
        Assert.Equal(_app.ExerciseA_SquatId, body.GetProperty("exerciseId").GetGuid());
        Assert.Equal(_app.RxAId, body.GetProperty("programDayExerciseId").GetGuid());
        Assert.Equal(1, body.GetProperty("setNumber").GetInt32());
        Assert.Equal(100.5m, body.GetProperty("weightKg").GetDecimal());
        Assert.Equal(8, body.GetProperty("reps").GetInt32());

        var persisted = _app.WithDb(db =>
            db.LoggedSetsForClient(_app.ClientAId).AsNoTracking().Single(s => s.Id == setId));
        Assert.Equal(workoutId, persisted.SessionId);
    }

    [Fact]
    public async Task Set_with_null_weight_kg_persists_as_null_for_bodyweight()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var workoutId = await CreateSessionAsync(session);

        var response = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{workoutId}/sets", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            programDayExerciseId = (Guid?)null,
            setNumber = 2,
            weightKg = (decimal?)null,
            reps = 12,
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, body.GetProperty("weightKg").ValueKind);
    }

    [Fact]
    public async Task Set_against_soft_deleted_exercise_is_still_allowed()
    {
        // Trainer retired an exercise mid-cycle; the client must still be able to log
        // today's session against it. Retirement blocks new prescription authoring
        // (ProgramDayExercise POST), not logging.
        var session = await _app.SignInAsync(_app.ClientAId);
        var workoutId = await CreateSessionAsync(session);

        var response = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{workoutId}/sets", session, new
        {
            exerciseId = _app.ExerciseA_InactiveId,
            programDayExerciseId = (Guid?)null,
            setNumber = 1,
            weightKg = 20m,
            reps = 10,
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    // The AC's marquee isolation test.
    [Fact]
    public async Task Client_A_posting_a_set_to_client_Bs_session_id_is_404()
    {
        var session = await _app.SignInAsync(_app.ClientAId);

        var response = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{_app.SessionB_Id}/sets", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            programDayExerciseId = (Guid?)null,
            setNumber = 1,
            weightKg = 100m,
            reps = 8,
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        // No set was created against B's session.
        var setsUnderBSession = _app.WithDb(db =>
            db.LoggedSetsForClient(_app.ClientBId).Count(s => s.SessionId == _app.SessionB_Id));
        Assert.Equal(0, setsUnderBSession);
    }

    [Fact]
    public async Task Set_against_nonexistent_session_id_is_404_indistinguishable()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var madeUp = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{Guid.NewGuid()}/sets", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            programDayExerciseId = (Guid?)null,
            setNumber = 1,
            weightKg = 100m,
            reps = 8,
        });
        var crossClient = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{_app.SessionB_Id}/sets", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            programDayExerciseId = (Guid?)null,
            setNumber = 1,
            weightKg = 100m,
            reps = 8,
        });

        Assert.Equal(HttpStatusCode.NotFound, madeUp.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, crossClient.StatusCode);
        Assert.Equal(
            await madeUp.Content.ReadAsStringAsync(),
            await crossClient.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Set_with_cross_tenant_exercise_id_is_400_unknown_exercise()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var workoutId = await CreateSessionAsync(session);

        var response = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{workoutId}/sets", session, new
        {
            exerciseId = _app.ExerciseBId, // trainer B's exercise
            programDayExerciseId = (Guid?)null,
            setNumber = 1,
            weightKg = 100m,
            reps = 8,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("unknown_exercise", body.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Set_with_cross_client_program_day_exercise_id_is_400()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var workoutId = await CreateSessionAsync(session);

        var response = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{workoutId}/sets", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            programDayExerciseId = _app.RxBId, // prescription in B's program
            setNumber = 1,
            weightKg = 100m,
            reps = 8,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("unknown_program_day_exercise",
            body.GetProperty("error").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData(0, 5)]      // set_number zero
    [InlineData(-1, 5)]     // set_number negative
    [InlineData(1, 0)]      // reps zero
    [InlineData(1, -3)]     // reps negative
    public async Task Set_rejects_non_positive_set_number_or_reps(int setNumber, int reps)
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var workoutId = await CreateSessionAsync(session);

        var response = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{workoutId}/sets", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            programDayExerciseId = (Guid?)null,
            setNumber,
            weightKg = 100m,
            reps,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Set_rejects_negative_weight_kg()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var workoutId = await CreateSessionAsync(session);

        var response = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{workoutId}/sets", session, new
        {
            exerciseId = _app.ExerciseA_SquatId,
            programDayExerciseId = (Guid?)null,
            setNumber = 1,
            weightKg = -5m,
            reps = 8,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // api.md: "Idempotency: POST /sessions/:id/sets is not idempotent and doesn't need
    // to be in v1 (double-tap creates a duplicate set the client can delete same-day)."
    [Fact]
    public async Task Duplicate_post_creates_duplicate_sets_by_design()
    {
        var session = await _app.SignInAsync(_app.ClientAId);
        var workoutId = await CreateSessionAsync(session);

        var body = new
        {
            exerciseId = _app.ExerciseA_SquatId,
            programDayExerciseId = (Guid?)null,
            setNumber = 1,
            weightKg = 100m,
            reps = 8,
        };

        var first = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{workoutId}/sets", session, body);
        var second = await SendAsync(HttpMethod.Post, $"/api/me/sessions/{workoutId}/sets", session, body);

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);

        var setsForSession = _app.WithDb(db =>
            db.LoggedSetsForClient(_app.ClientAId).Count(s => s.SessionId == workoutId));
        Assert.Equal(2, setsForSession);
    }
}
