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

// Two full tenants (trainer A + clients, trainer B + client) inside a shared-cache SQLite
// so every test can hit the AC's core question: does trainer A ever see or affect
// trainer B's data? Endpoints are mounted directly on a mini host — no Postgres, no
// rate limiter, no swagger — to keep test surface = endpoint surface.
public sealed class ClientEndpointsTestApp : IAsyncLifetime
{
    private readonly string _connectionString =
        $"Data Source=client-tests-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";

    private WebApplication _app = null!;
    private SqliteConnection _keepAlive = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;

    public Guid TrainerAId { get; } = Guid.NewGuid();
    public Guid TrainerBId { get; } = Guid.NewGuid();
    public Guid ClientA1Id { get; } = Guid.NewGuid();
    public Guid ClientA2Id { get; } = Guid.NewGuid();
    public Guid ClientB1Id { get; } = Guid.NewGuid();
    public Guid ScheduleA1Id { get; } = Guid.NewGuid();
    public Guid ScheduleB1Id { get; } = Guid.NewGuid();
    public Guid SessionA1_1Id { get; } = Guid.NewGuid();
    public Guid SessionA1_2Id { get; } = Guid.NewGuid();
    public Guid SessionB1Id { get; } = Guid.NewGuid();

    // #142: logged sets, so the trainer's history route has real rows to page and a real
    // cross-tenant sibling to reject.
    public Guid ExerciseA_SquatId { get; } = Guid.NewGuid();
    public Guid ExerciseBId { get; } = Guid.NewGuid();
    public Guid SetB1Id { get; } = Guid.NewGuid();

    public const string ClientA1Email = "alice@example.com";
    public const string ClientA2Email = "bob@example.com";
    public const string ClientB1Email = "carol@example.com";

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
        _app.MapGroup("/api").MapClientEndpoints();

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
                Id = ClientA1Id, Role = Roles.Client, Email = ClientA1Email,
                DisplayName = "Alice", TrainerId = TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = ClientA2Id, Role = Roles.Client, Email = ClientA2Email,
                DisplayName = "Bob", TrainerId = TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = ClientB1Id, Role = Roles.Client, Email = ClientB1Email,
                DisplayName = "Carol", TrainerId = TrainerBId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });

            db.Add(new NotificationSchedule
            {
                Id = ScheduleA1Id, TrainerId = TrainerAId, ClientId = ClientA1Id,
                Kind = "workout_reminder", SendTime = new TimeOnly(7, 0),
                DaysOfWeek = [1, 3, 5], Enabled = true,
            });
            db.Add(new NotificationSchedule
            {
                Id = ScheduleB1Id, TrainerId = TrainerBId, ClientId = ClientB1Id,
                Kind = "workout_reminder", SendTime = new TimeOnly(7, 0),
                DaysOfWeek = [1, 3, 5], Enabled = true,
            });

            db.Add(new WorkoutSession
            {
                Id = SessionA1_1Id, TrainerId = TrainerAId, ClientId = ClientA1Id,
                PerformedOn = new DateOnly(2026, 7, 18), Comment = "shoulder tweak", CreatedAt = Clock.Now,
            });
            db.Add(new WorkoutSession
            {
                Id = SessionA1_2Id, TrainerId = TrainerAId, ClientId = ClientA1Id,
                PerformedOn = new DateOnly(2026, 7, 20), Comment = null, CreatedAt = Clock.Now,
            });
            db.Add(new WorkoutSession
            {
                Id = SessionB1Id, TrainerId = TrainerBId, ClientId = ClientB1Id,
                PerformedOn = new DateOnly(2026, 7, 21), Comment = "B's session", CreatedAt = Clock.Now,
            });

            db.Add(new Exercise
            {
                Id = ExerciseA_SquatId, TrainerId = TrainerAId, Name = "Back Squat",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new Exercise
            {
                Id = ExerciseBId, TrainerId = TrainerBId, Name = "SECRET_B_EXERCISE",
                IsActive = true, CreatedAt = Clock.Now,
            });

            // Client A1: four sets across two sessions, logged_at ascending with the date so the
            // newest-first ordering and the cursor have something to be wrong about.
            var loggedAt = Clock.Now;
            for (var i = 0; i < 2; i++)
            {
                db.Add(new LoggedSet
                {
                    Id = Guid.NewGuid(), SessionId = SessionA1_1Id, ExerciseId = ExerciseA_SquatId,
                    SetNumber = i + 1, WeightKg = 100m + i, Reps = 5, LoggedAt = loggedAt.AddMinutes(i),
                });
            }
            for (var i = 0; i < 2; i++)
            {
                db.Add(new LoggedSet
                {
                    Id = Guid.NewGuid(), SessionId = SessionA1_2Id, ExerciseId = ExerciseA_SquatId,
                    SetNumber = i + 1, WeightKg = null, Reps = 8, LoggedAt = loggedAt.AddMinutes(10 + i),
                });
            }

            db.Add(new LoggedSet
            {
                Id = SetB1Id, SessionId = SessionB1Id, ExerciseId = ExerciseBId,
                SetNumber = 1, WeightKg = 999m, Reps = 1, LoggedAt = loggedAt.AddMinutes(20),
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

public class ClientEndpointsTests : IClassFixture<ClientEndpointsTestApp>
{
    private readonly ClientEndpointsTestApp _app;

    public ClientEndpointsTests(ClientEndpointsTestApp app)
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

    // -- Role gating (401 anonymous, 404 wrong role — per api.md pt 4) --

    [Fact]
    public async Task Anonymous_list_is_401()
    {
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/clients", null));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Client_role_list_is_404_not_403()
    {
        var session = await _app.SignInAsync(_app.ClientA1Id);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/clients", session));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- GET /api/clients --

    [Fact]
    public async Task Trainer_lists_only_own_clients_with_is_active()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/clients", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        var ids = body.EnumerateArray().Select(e => e.GetProperty("id").GetGuid()).ToHashSet();
        // Contains rather than set equality: the fixture is shared and every create test adds
        // a client to trainer A, so an exact-set assertion is a claim about which tests ran
        // first. What this test is actually for is the isolation line below it, and that is
        // unaffected by how many of A's own clients exist.
        Assert.Contains(_app.ClientA1Id, ids);
        Assert.Contains(_app.ClientA2Id, ids);
        Assert.DoesNotContain(_app.ClientB1Id, ids);

        // AC: list "includes is_active" — belt-and-braces on the field name.
        var first = body.EnumerateArray().First();
        Assert.True(first.TryGetProperty("isActive", out _));
    }

    // -- GET /api/clients: last_session_on (#115) --

    [Fact]
    public async Task Roster_carries_each_clients_most_recent_session_date()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/clients", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var rows = body.EnumerateArray().ToDictionary(e => e.GetProperty("id").GetGuid());

        // Alice trained on the 18th and the 20th. The 20th is the answer, and asserting it
        // rather than "some date" is what makes this a test of a max: the roster screen this
        // replaces read the *head* of a DESC-ordered list, so a subquery that happened to
        // return the wrong end would still have looked like it worked.
        Assert.Equal("2026-07-20", rows[_app.ClientA1Id].GetProperty("lastSessionOn").GetString());
    }

    [Fact]
    public async Task Roster_says_null_for_a_client_who_has_never_trained()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/clients", session));

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var bob = body.EnumerateArray().Single(e => e.GetProperty("id").GetGuid() == _app.ClientA2Id);

        // Present and null, not absent. #50: null is the claim "has never trained", and the
        // screen renders it as a sentence. An absent key would be a different statement.
        Assert.Equal(JsonValueKind.Null, bob.GetProperty("lastSessionOn").ValueKind);
    }

    [Fact]
    public async Task Roster_never_reports_another_trainers_session_date()
    {
        // Carol belongs to trainer B and trained on the 21st, later than anything of A's. The
        // subquery is scoped through WorkoutSessionsForTrainer as well as by client_id, so
        // neither her row nor her date can reach this response.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(Request(HttpMethod.Get, "/api/clients", session));

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var rows = body.EnumerateArray().ToList();

        Assert.DoesNotContain(rows, e => e.GetProperty("id").GetGuid() == _app.ClientB1Id);
        Assert.DoesNotContain(rows, e => e.GetProperty("lastSessionOn").GetString() == "2026-07-21");
    }

    [Fact]
    public async Task Deactivating_a_client_does_not_report_them_as_never_having_trained()
    {
        // The reason LastSessionFor exists. ClientsScreen folds a PATCH response back into the
        // roster row wholesale, so a PATCH that answered null for convenience would turn
        // "trained on the 20th" into "No sessions yet" at the moment of deactivation — #50's
        // rule broken through the write path, and indistinguishable on screen from a UI bug.
        var session = await _app.SignInAsync(_app.TrainerAId);

        var deactivated = await SendAsync(
            HttpMethod.Patch, $"/api/clients/{_app.ClientA1Id}", session, new { isActive = false });

        Assert.Equal(HttpStatusCode.OK, deactivated.StatusCode);
        var body = await deactivated.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(body.GetProperty("isActive").GetBoolean());
        Assert.Equal("2026-07-20", body.GetProperty("lastSessionOn").GetString());

        // Self-restoring, like the reactivation test below: the fixture is shared.
        await SendAsync(HttpMethod.Patch, $"/api/clients/{_app.ClientA1Id}", session, new { isActive = true });
    }

    // -- POST /api/clients --

    [Fact]
    public async Task Trainer_creates_client_scoped_under_own_trainer_id()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/clients", session, new
        {
            email = "new@example.com",
            displayName = "New Client",
            timezone = "America/Toronto",
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var newId = body.GetProperty("id").GetGuid();

        Assert.Equal("new@example.com", body.GetProperty("email").GetString());
        Assert.Equal("New Client", body.GetProperty("displayName").GetString());
        Assert.True(body.GetProperty("isActive").GetBoolean());
        // #115: null here is a fact rather than an unlooked-up default, which is why this is
        // the one path that does not query for it. The row was inserted a moment ago.
        Assert.Equal(JsonValueKind.Null, body.GetProperty("lastSessionOn").ValueKind);

        var persisted = _app.WithDb(db =>
            db.ClientsForTrainer(_app.TrainerAId).AsNoTracking().Single(u => u.Id == newId));
        Assert.Equal(Roles.Client, persisted.Role);
        Assert.Equal(_app.TrainerAId, persisted.TrainerId);
        Assert.True(persisted.IsActive);
        Assert.Null(persisted.PasswordHash);
    }

    [Theory]
    [InlineData(null, "Name", "America/Toronto")]
    [InlineData("", "Name", "America/Toronto")]
    [InlineData("valid@example.com", null, "America/Toronto")]
    [InlineData("valid@example.com", "   ", "America/Toronto")]
    [InlineData("valid@example.com", "Name", "")]
    [InlineData("not-an-email", "Name", "America/Toronto")]
    [InlineData("valid@example.com", "Name", "Not/A_Real_Zone")]
    public async Task Create_rejects_missing_or_invalid_fields_with_400(
        string? email, string? displayName, string? timezone)
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/clients", session, new
        {
            email, displayName, timezone,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("bad_request", body.GetProperty("error").GetProperty("code").GetString());
    }

    // #114: the bug this endpoint actually had. The old suite asserted one malformed address
    // ("not-an-email", still covered above), which MailAddress.TryCreate already refused — so
    // the check looked tested while every string below created a row. Each of these was
    // verified to pass a bare TryCreate.
    //
    // The assertion that no row was written is the point. A 400 that still inserted would be
    // the same silent failure wearing a different status code, and email is write-once: there
    // is no field on PATCH /api/clients/:id to correct one with afterwards.
    [Theory]
    [InlineData("Ada <ada@example.com>")]
    [InlineData("ada example@example.com")]
    [InlineData("<ada@example.com>")]
    [InlineData("ada@example.com, bob@example.com")]
    [InlineData("ada@localhost")]
    [InlineData("ada@example..com")]
    [InlineData("ada@-example.com")]
    public async Task Create_rejects_malformed_email_and_writes_nothing(string email)
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var before = _app.WithDb(db => db.ClientsForTrainer(_app.TrainerAId).Count());

        var response = await SendAsync(HttpMethod.Post, "/api/clients", session, new
        {
            email,
            displayName = "Malformed",
            timezone = "America/Toronto",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("bad_request", body.GetProperty("error").GetProperty("code").GetString());

        // The exact sentence, because the SPA's own client-side check is worded to match it and
        // no test can span both languages to prove they still agree. Pinning each side means a
        // change to either one fails here or in ClientsScreen.test.tsx, rather than the two
        // quietly drifting back apart.
        Assert.Equal(
            "Please enter a valid email address.",
            body.GetProperty("error").GetProperty("message").GetString());

        var after = _app.WithDb(db => db.ClientsForTrainer(_app.TrainerAId).Count());
        Assert.Equal(before, after);
        Assert.False(_app.WithDb(db => db.ClientsForTrainer(_app.TrainerAId).Any(u => u.Email == email)));
    }

    [Fact]
    public async Task Create_stores_the_address_exactly_as_given()
    {
        // The other half of #114: validation that parsed the address but stored the raw string
        // is how "Ada <ada@example.com>" ended up in users.email. Now that only bare addresses
        // get past the check, stored and typed are the same string — which is what makes
        // UserByEmail able to find the row a magic link is for.
        var session = await _app.SignInAsync(_app.TrainerAId);
        const string email = "round.trip@example.com";

        var response = await SendAsync(HttpMethod.Post, "/api/clients", session, new
        {
            email,
            displayName = "Round Trip",
            timezone = "America/Toronto",
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ClientsForTrainer(_app.TrainerAId).AsNoTracking().Single(u => u.Email == email));
        Assert.Equal(email, persisted.Email);
        // The lookup every magic link depends on resolves it.
        Assert.True(_app.WithDb(db => db.UserByEmail(email).Any()));
    }

    [Fact]
    public async Task Patch_cannot_change_an_email_at_all()
    {
        // #114 asked whether PATCH has the same gap. It does not, because it has no email
        // field — api.md's UpdateClientRequest is displayName/timezone/isActive. Pinned rather
        // than left as an observation: the day someone adds email here, it needs the same
        // validation, and this test failing is how they find that out.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/clients/{_app.ClientA1Id}", session, new
        {
            email = "Ada <ada@example.com>",
        });

        // api.md §Cross-cutting: unknown fields are rejected, not ignored.
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        var persisted = _app.WithDb(db =>
            db.ClientsForTrainer(_app.TrainerAId).AsNoTracking().Single(u => u.Id == _app.ClientA1Id));
        Assert.Equal(ClientEndpointsTestApp.ClientA1Email, persisted.Email);
    }

    [Fact]
    public async Task Create_with_duplicate_email_is_409()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/clients", session, new
        {
            email = ClientEndpointsTestApp.ClientA1Email,
            displayName = "Dup",
            timezone = "America/Toronto",
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("email_taken", body.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Create_rejects_unknown_body_fields()
    {
        // api.md §Cross-cutting: unknown fields rejected, not ignored.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/clients", session, new
        {
            email = "unknown-field@example.com",
            displayName = "X",
            timezone = "America/Toronto",
            role = "trainer", // attempt to elevate
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // -- PATCH /api/clients/:id --

    [Fact]
    public async Task Patch_updates_display_name_and_timezone()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/clients/{_app.ClientA2Id}", session, new
        {
            displayName = "Bob Renamed",
            timezone = "Europe/London",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.ClientsForTrainer(_app.TrainerAId).AsNoTracking().Single(u => u.Id == _app.ClientA2Id));
        Assert.Equal("Bob Renamed", persisted.DisplayName);
        Assert.Equal("Europe/London", persisted.Timezone);
        Assert.True(persisted.IsActive);
    }

    // AC: is_active=false also disables their notification schedules in a single transaction.
    [Fact]
    public async Task Patch_deactivating_client_also_disables_own_schedules()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/clients/{_app.ClientA1Id}", session, new
        {
            isActive = false,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var (clientActive, ownSchedule, otherSchedule) = _app.WithDb(db => (
            db.ClientsForTrainer(_app.TrainerAId).AsNoTracking().Single(u => u.Id == _app.ClientA1Id).IsActive,
            db.NotificationSchedulesForTrainer(_app.TrainerAId).AsNoTracking().Single(s => s.Id == _app.ScheduleA1Id).Enabled,
            db.NotificationSchedulesForTrainer(_app.TrainerBId).AsNoTracking().Single(s => s.Id == _app.ScheduleB1Id).Enabled
        ));

        Assert.False(clientActive);
        Assert.False(ownSchedule);
        // Cross-tenant safety: trainer B's schedule for their own client is untouched.
        Assert.True(otherSchedule);
    }

    [Fact]
    public async Task Patch_reactivating_client_does_not_reenable_schedules()
    {
        // The AC binds deactivation to schedule-disable. Reactivation is not symmetric — enabling
        // schedules again is an explicit trainer choice via the schedule route.
        var session = await _app.SignInAsync(_app.TrainerAId);
        await SendAsync(HttpMethod.Patch, $"/api/clients/{_app.ClientA1Id}", session, new { isActive = false });

        var response = await SendAsync(HttpMethod.Patch, $"/api/clients/{_app.ClientA1Id}", session, new { isActive = true });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var schedule = _app.WithDb(db =>
            db.NotificationSchedulesForTrainer(_app.TrainerAId).AsNoTracking().Single(s => s.Id == _app.ScheduleA1Id));
        Assert.False(schedule.Enabled);
    }

    [Fact]
    public async Task Patch_with_invalid_timezone_is_400()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/clients/{_app.ClientA2Id}", session, new
        {
            timezone = "Not/A_Real_Zone",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Patch_with_blank_display_name_is_400()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/clients/{_app.ClientA2Id}", session, new
        {
            displayName = "   ",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // -- Isolation (the AC's core test) --

    [Fact]
    public async Task Patching_another_trainers_client_is_404()
    {
        // conventions.md §Isolation tests: trainer A hitting trainer B's client id must
        // return the same 404 as a fabricated id — no existence oracle.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/clients/{_app.ClientB1Id}", session, new
        {
            displayName = "Hijack",
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        var untouched = _app.WithDb(db =>
            db.Find<User>(_app.ClientB1Id)!);
        Assert.Equal("Carol", untouched.DisplayName);
    }

    [Fact]
    public async Task Nonexistent_client_id_is_404_indistinguishable_from_cross_tenant()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var madeUp = Guid.NewGuid();

        var madeUpPatch = await SendAsync(
            HttpMethod.Patch, $"/api/clients/{madeUp}", session, new { displayName = "x" });
        var otherPatch = await SendAsync(
            HttpMethod.Patch, $"/api/clients/{_app.ClientB1Id}", session, new { displayName = "x" });
        // #147 deleted GET /clients/:id/sessions, which used to be the read half of this pair.
        // The pairing is the point of the test rather than the route: a write and a read must
        // both answer identically for a fabricated id and a foreign one, because a difference in
        // either direction is an existence oracle. /history is the surviving GET of that shape.
        var madeUpRead = await SendAsync(HttpMethod.Get, $"/api/clients/{madeUp}/history", session);
        var otherRead = await SendAsync(
            HttpMethod.Get, $"/api/clients/{_app.ClientB1Id}/history", session);

        Assert.Equal(HttpStatusCode.NotFound, madeUpPatch.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, otherPatch.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, madeUpRead.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, otherRead.StatusCode);

        // Bodies match too — no length or shape oracle.
        Assert.Equal(
            await madeUpPatch.Content.ReadAsStringAsync(),
            await otherPatch.Content.ReadAsStringAsync());
        Assert.Equal(
            await madeUpRead.Content.ReadAsStringAsync(),
            await otherRead.Content.ReadAsStringAsync());
    }

    // -- weight_unit (#99) --

    [Fact]
    public async Task Create_defaults_the_weight_unit_when_omitted()
    {
        // Omitted is the overwhelmingly common case, and lb is the default because most
        // Canadian gyms load pound plates.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/clients", session, new
        {
            email = $"unit-default-{Guid.NewGuid():N}@example.com",
            displayName = "Default Unit",
            timezone = "America/Toronto",
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(WeightUnits.Lb, body.GetProperty("weightUnit").GetString());
    }

    [Fact]
    public async Task Create_accepts_an_explicit_weight_unit()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/clients", session, new
        {
            email = $"unit-kg-{Guid.NewGuid():N}@example.com",
            displayName = "Kg Thinker",
            timezone = "America/Toronto",
            weightUnit = "kg",
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(WeightUnits.Kg, body.GetProperty("weightUnit").GetString());
    }

    [Fact]
    public async Task Create_rejects_an_unrecognized_weight_unit_rather_than_defaulting()
    {
        // Sent-but-wrong is a 400, not a silent fallback to lb: quietly ignoring the trainer on
        // a client they said thinks in kg is the worse of the two failures.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Post, "/api/clients", session, new
        {
            email = $"unit-bad-{Guid.NewGuid():N}@example.com",
            displayName = "Bad Unit",
            timezone = "America/Toronto",
            weightUnit = "stone",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("bad_request", body.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Patch_updates_the_weight_unit()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Patch, $"/api/clients/{_app.ClientA1Id}", session, new { weightUnit = "KG" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        // Normalized, same as PATCH /api/me.
        Assert.Equal(WeightUnits.Kg, body.GetProperty("weightUnit").GetString());

        _app.WithDb(db =>
        {
            db.Find<User>(_app.ClientA1Id)!.WeightUnit = WeightUnits.Default;
            db.SaveChanges();
        });
    }

    // -- GET /api/clients/:id/history (#142) --

    [Fact]
    public async Task Anonymous_history_is_401()
    {
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{_app.ClientA1Id}/history", null));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Client_role_history_is_404_not_403()
    {
        var session = await _app.SignInAsync(_app.ClientA1Id);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{_app.ClientA1Id}/history", session));
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task History_returns_the_clients_sets_newest_first_with_exercise_and_session()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Get, $"/api/clients/{_app.ClientA1Id}/history", session);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var items = body.GetProperty("items").EnumerateArray().ToList();

        Assert.Equal(4, items.Count);

        // Newest first, which is the order the SPA's grouping assumes.
        var loggedAt = items.Select(i => i.GetProperty("loggedAt").GetDateTimeOffset()).ToList();
        Assert.Equal(loggedAt.OrderByDescending(t => t).ToList(), loggedAt);

        // Each set carries enough to render without a second lookup: its session summary and
        // its exercise name.
        var first = items[0];
        Assert.Equal("Back Squat", first.GetProperty("exercise").GetProperty("name").GetString());
        Assert.Equal(_app.SessionA1_2Id, first.GetProperty("session").GetProperty("id").GetGuid());
        Assert.Equal("2026-07-20", first.GetProperty("session").GetProperty("performedOn").GetString());

        // The comment rides on the session summary — it is the reason this screen exists as
        // much as the sets are (database.md: the v1 substitute for messaging).
        var withComment = items.First(i =>
            i.GetProperty("session").GetProperty("id").GetGuid() == _app.SessionA1_1Id);
        Assert.Equal("shoulder tweak", withComment.GetProperty("session").GetProperty("comment").GetString());
    }

    [Fact]
    public async Task History_returns_canonical_kilograms_and_does_not_convert()
    {
        // #99: storage is one unit and no endpoint converts. Which unit a reader sees is decided
        // at the display boundary from the *client's* weight_unit — there is no trainer
        // preference and database.md §users records why.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Get, $"/api/clients/{_app.ClientA1Id}/history", session);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        var weights = body.GetProperty("items").EnumerateArray()
            .Select(i => i.GetProperty("weightKg"))
            .Select(w => w.ValueKind == JsonValueKind.Null ? (decimal?)null : w.GetDecimal())
            .ToList();

        Assert.Contains(100m, weights);
        Assert.Contains(101m, weights);
        // Bodyweight stays null rather than becoming a zero in any unit.
        Assert.Equal(2, weights.Count(w => w is null));
    }

    [Fact]
    public async Task History_pages_with_the_cursor_rather_than_an_offset()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);

        var firstPage = await SendAsync(
            HttpMethod.Get, $"/api/clients/{_app.ClientA1Id}/history?limit=2", session);
        var first = await firstPage.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(2, first.GetProperty("items").GetArrayLength());
        var cursor = first.GetProperty("nextCursor").GetDateTimeOffset();

        var secondPage = await SendAsync(
            HttpMethod.Get,
            $"/api/clients/{_app.ClientA1Id}/history?limit=2&before={Uri.EscapeDataString(cursor.ToString("O"))}",
            session);
        var second = await secondPage.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(2, second.GetProperty("items").GetArrayLength());
        // Full final page, so nextCursor is still set; the page after it is empty.
        var firstIds = first.GetProperty("items").EnumerateArray()
            .Select(i => i.GetProperty("id").GetGuid()).ToHashSet();
        var secondIds = second.GetProperty("items").EnumerateArray()
            .Select(i => i.GetProperty("id").GetGuid()).ToHashSet();
        Assert.Empty(firstIds.Intersect(secondIds));
    }

    [Fact]
    public async Task History_refuses_a_limit_outside_the_range()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);

        foreach (var limit in new[] { "0", "-1", "101" })
        {
            var response = await SendAsync(
                HttpMethod.Get, $"/api/clients/{_app.ClientA1Id}/history?limit={limit}", session);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        }
    }

    [Fact]
    public async Task History_of_another_trainers_client_is_the_same_404_as_a_made_up_id()
    {
        // The mandatory isolation shape (api.md §Authorization pt 2). Both the status and the
        // body have to match, or the pair is an existence oracle.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var madeUp = Guid.NewGuid();

        var foreign = await SendAsync(HttpMethod.Get, $"/api/clients/{_app.ClientB1Id}/history", session);
        var fabricated = await SendAsync(HttpMethod.Get, $"/api/clients/{madeUp}/history", session);

        Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, fabricated.StatusCode);
        Assert.Equal(
            await foreign.Content.ReadAsStringAsync(),
            await fabricated.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task History_never_leaks_another_trainers_rows()
    {
        // Belt and braces on top of the 404: the sets query is scoped through
        // LoggedSetsForTrainer, so even a bug in the existence check above could not return B's
        // rows. Asserted against the raw body so a nested field cannot hide one.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var raw = await (await SendAsync(
            HttpMethod.Get, $"/api/clients/{_app.ClientA1Id}/history", session)).Content.ReadAsStringAsync();

        Assert.DoesNotContain("SECRET_B_EXERCISE", raw);
        Assert.DoesNotContain(_app.SetB1Id.ToString(), raw);
        Assert.DoesNotContain(_app.SessionB1Id.ToString(), raw);
        Assert.DoesNotContain("999", raw);
    }

    [Fact]
    public async Task History_of_a_client_with_nothing_logged_is_an_empty_page_not_a_404()
    {
        // A2 exists and has never trained. Empty state is not an error — the same rule
        // GET /api/me/program follows for "no active program" (#30).
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Get, $"/api/clients/{_app.ClientA2Id}/history", session);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(0, body.GetProperty("items").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("nextCursor").ValueKind);
    }

    [Fact]
    public async Task Patch_cannot_set_another_trainers_client_unit()
    {
        // The mandatory isolation shape for a client-facing route with an id in the URL: a
        // foreign id is the same 404 as a fabricated one, and nothing is written.
        var before = _app.WithDb(db => db.Find<User>(_app.ClientB1Id)!.WeightUnit);

        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Patch, $"/api/clients/{_app.ClientB1Id}", session, new { weightUnit = "kg" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(before, _app.WithDb(db => db.Find<User>(_app.ClientB1Id)!.WeightUnit));
    }
}
