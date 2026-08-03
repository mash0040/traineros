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

    [Fact]
    public async Task Client_role_get_sessions_is_404_not_403()
    {
        // The client's own id in a trainer-only route must not leak "you exist, wrong role."
        var session = await _app.SignInAsync(_app.ClientA1Id);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{_app.ClientA1Id}/sessions", session));

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

    // -- GET /api/clients/:id/sessions --

    [Fact]
    public async Task Get_sessions_returns_this_clients_sessions_newest_first()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{_app.ClientA1Id}/sessions", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var ids = body.EnumerateArray().Select(e => e.GetProperty("id").GetGuid()).ToList();

        // A1_2 (2026-07-20) is newer than A1_1 (2026-07-18); B1's session must not appear.
        Assert.Equal([_app.SessionA1_2Id, _app.SessionA1_1Id], ids);
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
    public async Task Get_sessions_for_another_trainers_client_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{_app.ClientB1Id}/sessions", session));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
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
        var madeUpSessions = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{madeUp}/sessions", session));
        var otherSessions = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{_app.ClientB1Id}/sessions", session));

        Assert.Equal(HttpStatusCode.NotFound, madeUpPatch.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, otherPatch.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, madeUpSessions.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, otherSessions.StatusCode);

        // Bodies match too — no length or shape oracle.
        Assert.Equal(
            await madeUpPatch.Content.ReadAsStringAsync(),
            await otherPatch.Content.ReadAsStringAsync());
        Assert.Equal(
            await madeUpSessions.Content.ReadAsStringAsync(),
            await otherSessions.Content.ReadAsStringAsync());
    }
}
