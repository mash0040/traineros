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

// Two full tenants + a mix of clients (active, deactivated, and cross-tenant) so the
// deactivated-client policy decision and the "one schedule per client" 409 both have
// real backing data.
public sealed class NotificationScheduleEndpointsTestApp : IAsyncLifetime
{
    private readonly string _connectionString =
        $"Data Source=schedule-tests-{Guid.NewGuid():N};Mode=Memory;Cache=Shared";

    private WebApplication _app = null!;
    private SqliteConnection _keepAlive = null!;

    public FakeClock Clock { get; } = new();
    public HttpClient Client { get; private set; } = null!;

    public Guid TrainerAId { get; } = Guid.NewGuid();
    public Guid TrainerBId { get; } = Guid.NewGuid();
    public Guid ClientA_ScheduledId { get; } = Guid.NewGuid();
    public Guid ClientA_UnscheduledId { get; } = Guid.NewGuid();
    public Guid ClientA_DeactivatedId { get; } = Guid.NewGuid();
    public Guid ClientBId { get; } = Guid.NewGuid();
    public Guid ScheduleA_Id { get; } = Guid.NewGuid();
    public Guid ScheduleB_Id { get; } = Guid.NewGuid();

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
        _app.MapGroup("/api").MapNotificationScheduleEndpoints();

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
                Id = ClientA_ScheduledId, Role = Roles.Client, Email = "alice@example.com",
                DisplayName = "Alice", TrainerId = TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = ClientA_UnscheduledId, Role = Roles.Client, Email = "bob@example.com",
                DisplayName = "Bob", TrainerId = TrainerAId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = ClientA_DeactivatedId, Role = Roles.Client, Email = "dana@example.com",
                DisplayName = "Dana", TrainerId = TrainerAId, Timezone = "America/Toronto",
                IsActive = false, CreatedAt = Clock.Now,
            });
            db.Add(new User
            {
                Id = ClientBId, Role = Roles.Client, Email = "carol@example.com",
                DisplayName = "Carol", TrainerId = TrainerBId, Timezone = "America/Toronto",
                IsActive = true, CreatedAt = Clock.Now,
            });

            db.Add(new NotificationSchedule
            {
                Id = ScheduleA_Id, TrainerId = TrainerAId, ClientId = ClientA_ScheduledId,
                Kind = "workout_reminder", SendTime = new TimeOnly(7, 0),
                DaysOfWeek = [1, 3, 5], Enabled = true,
            });
            db.Add(new NotificationSchedule
            {
                Id = ScheduleB_Id, TrainerId = TrainerBId, ClientId = ClientBId,
                Kind = "workout_reminder", SendTime = new TimeOnly(8, 0),
                DaysOfWeek = [2, 4], Enabled = true,
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

public class NotificationScheduleEndpointsTests : IClassFixture<NotificationScheduleEndpointsTestApp>
{
    private readonly NotificationScheduleEndpointsTestApp _app;

    public NotificationScheduleEndpointsTests(NotificationScheduleEndpointsTestApp app)
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
    public async Task Anonymous_get_is_401()
    {
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{_app.ClientA_ScheduledId}/schedule", null));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Client_role_get_is_404_not_403()
    {
        var session = await _app.SignInAsync(_app.ClientA_ScheduledId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{_app.ClientA_ScheduledId}/schedule", session));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // -- GET /api/clients/:id/schedule --

    [Fact]
    public async Task Get_returns_the_clients_schedule()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{_app.ClientA_ScheduledId}/schedule", session));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        // Only assert on identity + shape — sendTime/daysOfWeek/enabled are mutated
        // by PATCH tests through the shared fixture.
        Assert.Equal(_app.ScheduleA_Id, body.GetProperty("id").GetGuid());
        Assert.Equal(_app.ClientA_ScheduledId, body.GetProperty("clientId").GetGuid());
        Assert.Equal("workout_reminder", body.GetProperty("kind").GetString());
        Assert.False(string.IsNullOrEmpty(body.GetProperty("sendTime").GetString()));
        Assert.True(body.GetProperty("daysOfWeek").GetArrayLength() > 0);
    }

    [Fact]
    public async Task Get_when_no_schedule_is_404_indistinguishable_from_cross_tenant()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var noSchedule = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{_app.ClientA_UnscheduledId}/schedule", session));
        var crossTenant = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{_app.ClientBId}/schedule", session));
        var madeUp = await _app.Client.SendAsync(
            Request(HttpMethod.Get, $"/api/clients/{Guid.NewGuid()}/schedule", session));

        Assert.Equal(HttpStatusCode.NotFound, noSchedule.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, crossTenant.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, madeUp.StatusCode);

        // Byte-identical: an owned-client-with-no-schedule reads exactly like a
        // cross-tenant client id, preserving the no-existence-oracle invariant.
        Assert.Equal(
            await noSchedule.Content.ReadAsStringAsync(),
            await crossTenant.Content.ReadAsStringAsync());
    }

    // -- POST /api/clients/:id/schedule --

    [Fact]
    public async Task Post_creates_the_schedule_with_normalized_days()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Post, $"/api/clients/{_app.ClientA_UnscheduledId}/schedule", session, new
            {
                sendTime = "18:30:00",
                daysOfWeek = new[] { 5, 1, 3 }, // out of order on the wire
                enabled = (bool?)null,
            });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var newId = body.GetProperty("id").GetGuid();

        Assert.Equal(_app.ClientA_UnscheduledId, body.GetProperty("clientId").GetGuid());
        Assert.Equal("workout_reminder", body.GetProperty("kind").GetString());
        Assert.Equal("18:30:00", body.GetProperty("sendTime").GetString());
        Assert.True(body.GetProperty("enabled").GetBoolean()); // default when omitted

        var persisted = _app.WithDb(db =>
            db.NotificationSchedulesForTrainer(_app.TrainerAId).AsNoTracking().Single(s => s.Id == newId));
        // Days normalized to sorted+deduped canonical form.
        Assert.Equal(new[] { 1, 3, 5 }, persisted.DaysOfWeek);
        Assert.Equal(_app.TrainerAId, persisted.TrainerId);
    }

    // -- Wire time format (#79) --
    //
    // No converter. The issue asked for a JsonConverter<TimeOnly> accepting HH:mm, on the
    // premise that the framework default required seconds — true when #29's smoke test hit it,
    // and not true on .NET 8, whose built-in TimeOnly converter accepts HH:mm, HH:mm:ss and a
    // fractional part. Writing one would have *narrowed* what the API accepts (the stock reader
    // also takes "7:00"; a TryParseExact list does not) and changed the sub-second output shape,
    // both for no gain. What was missing was not behaviour but evidence: nothing asserted the
    // format the SPA depends on, so it was free to regress on a framework upgrade or the day
    // someone registers a converter of their own. These tests are that evidence.

    [Theory]
    [InlineData("07:00")]
    [InlineData("07:00:00")]
    public async Task Post_accepts_a_time_with_or_without_seconds(string sent)
    {
        // The AC. #29's smoke test saw "07:00" rejected and #51 worked around it in the SPA by
        // appending ":00" before every send; that workaround is what #79 removes.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Post, $"/api/clients/{_app.ClientA_UnscheduledId}/schedule", session, new
            {
                sendTime = sent,
                daysOfWeek = new[] { 1 },
                enabled = true,
            });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var newId = body.GetProperty("id").GetGuid();

        // Emitted with seconds whichever form went in. Asserted because the output format is the
        // half of this the SPA still converts for: toInputTime exists to strip these.
        Assert.Equal("07:00:00", body.GetProperty("sendTime").GetString());

        _app.WithDb(db =>
        {
            var row = db.NotificationSchedulesForTrainer(_app.TrainerAId).Single(s => s.Id == newId);
            Assert.Equal(new TimeOnly(7, 0), row.SendTime);
            db.Remove(row);
            db.SaveChanges();
        });
    }

    [Fact]
    public async Task Patch_accepts_hh_mm_through_the_patch_wrapper()
    {
        // The path a trainer actually takes: editing an existing schedule is a PATCH, whose
        // sendTime is a Patch<TimeOnly> (#145) and so is read by two converters composing.
        // PatchConverter delegates with the JsonSerializerOptions it was handed rather than a
        // fresh set, which is what keeps the TimeOnly reader in play underneath it. Nothing in
        // either type states that dependency, so it is recorded here.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Patch, $"/api/schedules/{_app.ScheduleA_Id}", session, new
            {
                sendTime = "07:00",
            });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.NotificationSchedulesForTrainer(_app.TrainerAId)
                .AsNoTracking().Single(s => s.Id == _app.ScheduleA_Id));
        Assert.Equal(new TimeOnly(7, 0), persisted.SendTime);
    }

    [Fact]
    public async Task Patch_omitting_send_time_still_leaves_it_alone()
    {
        // #145's three-state reading has to survive the TimeOnly reader sitting under it: an
        // absent field must not reach the inner converter at all.
        var session = await _app.SignInAsync(_app.TrainerAId);
        await SendAsync(HttpMethod.Patch, $"/api/schedules/{_app.ScheduleA_Id}", session, new
        {
            sendTime = "06:45",
        });

        var response = await SendAsync(HttpMethod.Patch, $"/api/schedules/{_app.ScheduleA_Id}", session, new
        {
            enabled = true,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.NotificationSchedulesForTrainer(_app.TrainerAId)
                .AsNoTracking().Single(s => s.Id == _app.ScheduleA_Id));
        Assert.Equal(new TimeOnly(6, 45), persisted.SendTime);
    }

    [Fact]
    public async Task Patch_with_null_send_time_is_still_400()
    {
        // The other end of the same composition: send_time backs a NOT NULL column, and the null
        // token is answered by PatchConverter before the TimeOnly reader would see it (#145).
        var session = await _app.SignInAsync(_app.TrainerAId);
        var request = Request(HttpMethod.Patch, $"/api/schedules/{_app.ScheduleA_Id}", session);
        request.Content = new StringContent(
            "{\"sendTime\": null}", System.Text.Encoding.UTF8, "application/json");

        var response = await _app.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains("send_time", body.GetProperty("error").GetProperty("message").GetString());
    }

    [Theory]
    [InlineData("half seven")]
    [InlineData("25:00")]
    [InlineData("")]
    public async Task A_malformed_send_time_is_400_not_500(string sent)
    {
        // The reader throws JsonException, which ThrowOnBadRequest lifts to a
        // BadHttpRequestException for UseApiErrorHandling to shape. Without that path a typo
        // would be an unhandled 500.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Post, $"/api/clients/{_app.ClientA_UnscheduledId}/schedule", session, new
            {
                sendTime = sent,
                daysOfWeek = new[] { 1 },
                enabled = true,
            });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("bad_request", body.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Post_duplicate_schedule_is_409()
    {
        // AC: one schedule per client. App-enforced pre-check → 409.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Post, $"/api/clients/{_app.ClientA_ScheduledId}/schedule", session, new
            {
                sendTime = "07:30:00",
                daysOfWeek = new[] { 2 },
                enabled = true,
            });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("schedule_exists", body.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Post_for_cross_tenant_client_is_404()
    {
        // Route-param identity check: 404 without touching the request body — no
        // existence oracle for another trainer's client.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var crossTenant = await SendAsync(
            HttpMethod.Post, $"/api/clients/{_app.ClientBId}/schedule", session, new
            {
                sendTime = "07:00:00",
                daysOfWeek = new[] { 1 },
                enabled = true,
            });
        var madeUp = await SendAsync(
            HttpMethod.Post, $"/api/clients/{Guid.NewGuid()}/schedule", session, new
            {
                sendTime = "07:00:00",
                daysOfWeek = new[] { 1 },
                enabled = true,
            });

        Assert.Equal(HttpStatusCode.NotFound, crossTenant.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, madeUp.StatusCode);
    }

    // Deactivated-client policy: allow. Send-time guard in the worker keeps email
    // from leaking (notifications.md skip rule). Trainer intent survives the pause.
    [Fact]
    public async Task Post_for_deactivated_client_is_allowed()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Post, $"/api/clients/{_app.ClientA_DeactivatedId}/schedule", session, new
            {
                sendTime = "07:00:00",
                daysOfWeek = new[] { 1, 3 },
                enabled = true,
            });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    [Fact]
    public async Task Post_rejects_missing_send_time()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Post, $"/api/clients/{_app.ClientA_UnscheduledId}/schedule", session, new
            {
                sendTime = (string?)null,
                daysOfWeek = new[] { 1 },
                enabled = true,
            });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData(new int[] { })]
    [InlineData(new[] { -1 })]
    [InlineData(new[] { 7 })]
    [InlineData(new[] { 1, 1 })]
    public async Task Post_rejects_invalid_days_of_week(int[] days)
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Post, $"/api/clients/{_app.ClientA_UnscheduledId}/schedule", session, new
            {
                sendTime = "07:00:00",
                daysOfWeek = days,
                enabled = true,
            });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Post_rejects_unknown_body_fields()
    {
        // api.md §Cross-cutting: unknown fields rejected. `kind` is a common wrong guess.
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(
            HttpMethod.Post, $"/api/clients/{_app.ClientA_UnscheduledId}/schedule", session, new
            {
                sendTime = "07:00:00",
                daysOfWeek = new[] { 1 },
                enabled = true,
                kind = "trainer_digest",
            });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // -- PATCH /api/schedules/:id --

    [Fact]
    public async Task Patch_updates_editable_fields()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/schedules/{_app.ScheduleA_Id}", session, new
        {
            sendTime = "06:15:00",
            daysOfWeek = new[] { 0, 6 },
            enabled = false,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.NotificationSchedulesForTrainer(_app.TrainerAId).AsNoTracking().Single(s => s.Id == _app.ScheduleA_Id));
        Assert.Equal(new TimeOnly(6, 15), persisted.SendTime);
        Assert.Equal(new[] { 0, 6 }, persisted.DaysOfWeek);
        Assert.False(persisted.Enabled);
    }

    // notifications.md resolved question 2: the pause link sets enabled=false, and the
    // trainer re-enables from the dashboard. This is the endpoint that powers that.
    [Fact]
    public async Task Patch_re_enables_after_pause()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);

        await SendAsync(HttpMethod.Patch, $"/api/schedules/{_app.ScheduleA_Id}", session, new { enabled = false });

        var response = await SendAsync(HttpMethod.Patch, $"/api/schedules/{_app.ScheduleA_Id}", session, new { enabled = true });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.NotificationSchedulesForTrainer(_app.TrainerAId).AsNoTracking().Single(s => s.Id == _app.ScheduleA_Id));
        Assert.True(persisted.Enabled);
    }

    [Fact]
    public async Task Patch_leaves_untouched_fields_alone()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        // Reset to a known state; the shared fixture drifts across tests.
        await SendAsync(HttpMethod.Patch, $"/api/schedules/{_app.ScheduleA_Id}", session, new
        {
            sendTime = "07:00:00",
            daysOfWeek = new[] { 1, 3, 5 },
            enabled = true,
        });

        var response = await SendAsync(HttpMethod.Patch, $"/api/schedules/{_app.ScheduleA_Id}", session, new
        {
            enabled = false,
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var persisted = _app.WithDb(db =>
            db.NotificationSchedulesForTrainer(_app.TrainerAId).AsNoTracking().Single(s => s.Id == _app.ScheduleA_Id));
        Assert.Equal(new TimeOnly(7, 0), persisted.SendTime);
        Assert.Equal(new[] { 1, 3, 5 }, persisted.DaysOfWeek);
        Assert.False(persisted.Enabled);
    }

    [Theory]
    [InlineData(new int[] { })]
    [InlineData(new[] { 8 })]
    [InlineData(new[] { 2, 2 })]
    public async Task Patch_rejects_invalid_days_of_week(int[] days)
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/schedules/{_app.ScheduleA_Id}", session, new
        {
            daysOfWeek = days,
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Patch_other_trainers_schedule_is_404()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var response = await SendAsync(HttpMethod.Patch, $"/api/schedules/{_app.ScheduleB_Id}", session, new
        {
            enabled = false,
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        var untouched = _app.WithDb(db => db.Find<NotificationSchedule>(_app.ScheduleB_Id)!);
        Assert.True(untouched.Enabled);
    }

    [Fact]
    public async Task Patch_nonexistent_schedule_is_404_indistinguishable()
    {
        var session = await _app.SignInAsync(_app.TrainerAId);
        var madeUp = await SendAsync(HttpMethod.Patch, $"/api/schedules/{Guid.NewGuid()}", session, new
        {
            enabled = false,
        });
        var crossTenant = await SendAsync(HttpMethod.Patch, $"/api/schedules/{_app.ScheduleB_Id}", session, new
        {
            enabled = false,
        });

        Assert.Equal(HttpStatusCode.NotFound, madeUp.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, crossTenant.StatusCode);
        Assert.Equal(
            await madeUp.Content.ReadAsStringAsync(),
            await crossTenant.Content.ReadAsStringAsync());
    }
}
