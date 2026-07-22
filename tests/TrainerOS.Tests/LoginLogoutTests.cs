using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using TrainerOS.Api.Auth;

namespace TrainerOS.Tests;

public class LoginLogoutTests : IClassFixture<MagicLinkTestApp>
{
    private readonly MagicLinkTestApp _app;

    public LoginLogoutTests(MagicLinkTestApp app)
    {
        _app = app;
        _app.Clock.Now = FakeClock.BaseNow;
    }

    private Task<HttpResponseMessage> Login(string email, string password)
        => _app.Client.PostAsJsonAsync("/api/auth/login", new { email, password });

    private static Guid SessionIdFromCookie(string setCookie)
        => Guid.Parse(setCookie.Split(';')[0].Split('=')[1]);

    [Fact]
    public async Task Correct_credentials_create_30_day_trainer_session_with_cookie()
    {
        var response = await Login(MagicLinkTestApp.TrainerEmail, MagicLinkTestApp.TrainerPassword);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var setCookie = Assert.Single(response.Headers.GetValues("Set-Cookie"));
        Assert.StartsWith($"{SessionCookie.Name}=", setCookie);
        Assert.Contains("httponly", setCookie, StringComparison.OrdinalIgnoreCase);

        var sessionId = SessionIdFromCookie(setCookie);
        var session = _app.WithDb(db => db.Sessions.Single(s => s.Id == sessionId));
        Assert.Equal(_app.TrainerUserId, session.UserId);
        Assert.Equal(FakeClock.BaseNow + SessionService.TrainerLifetime, session.ExpiresAt);
    }

    [Fact]
    public async Task Unknown_email_and_wrong_password_are_indistinguishable()
    {
        var unknownEmail = await Login("nobody@example.com", "whatever");
        var wrongPassword = await Login(MagicLinkTestApp.TrainerEmail, "wrong password");

        Assert.Equal(HttpStatusCode.Unauthorized, unknownEmail.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, wrongPassword.StatusCode);
        Assert.Equal(
            await unknownEmail.Content.ReadAsStringAsync(),
            await wrongPassword.Content.ReadAsStringAsync());

        var body = await wrongPassword.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid_credentials", body.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Client_email_is_rejected_identically_even_with_any_password()
    {
        // Clients have no password; the login path is trainer-only (api.md).
        var clientAttempt = await Login(MagicLinkTestApp.ClientEmail, "anything");
        var unknownAttempt = await Login("nobody@example.com", "anything");

        Assert.Equal(HttpStatusCode.Unauthorized, clientAttempt.StatusCode);
        Assert.Equal(
            await unknownAttempt.Content.ReadAsStringAsync(),
            await clientAttempt.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Blank_fields_are_rejected_with_400()
    {
        var response = await Login("", "");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Logout_revokes_the_current_session_and_expires_the_cookie()
    {
        var login = await Login(MagicLinkTestApp.TrainerEmail, MagicLinkTestApp.TrainerPassword);
        var sessionId = SessionIdFromCookie(Assert.Single(login.Headers.GetValues("Set-Cookie")));

        var logoutRequest = new HttpRequestMessage(HttpMethod.Post, "/api/auth/logout");
        logoutRequest.Headers.Add("Cookie", $"{SessionCookie.Name}={sessionId}");
        var logout = await _app.Client.SendAsync(logoutRequest);

        Assert.Equal(HttpStatusCode.OK, logout.StatusCode);
        var session = _app.WithDb(db => db.Sessions.Single(s => s.Id == sessionId));
        Assert.Equal(FakeClock.BaseNow, session.RevokedAt);

        // The response also expires the cookie client-side.
        var clearCookie = Assert.Single(logout.Headers.GetValues("Set-Cookie"));
        Assert.StartsWith($"{SessionCookie.Name}=", clearCookie);
        Assert.Contains("expires=", clearCookie, StringComparison.OrdinalIgnoreCase);

        // Second logout with the same dead cookie is still a 200 (idempotent).
        var again = new HttpRequestMessage(HttpMethod.Post, "/api/auth/logout");
        again.Headers.Add("Cookie", $"{SessionCookie.Name}={sessionId}");
        Assert.Equal(HttpStatusCode.OK, (await _app.Client.SendAsync(again)).StatusCode);
        Assert.Equal(FakeClock.BaseNow,
            _app.WithDb(db => db.Sessions.Single(s => s.Id == sessionId)).RevokedAt);
    }

    [Fact]
    public async Task Logout_without_any_session_is_a_200_noop()
    {
        var response = await _app.Client.PostAsync("/api/auth/logout", null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
