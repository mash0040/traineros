using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Entities;

using MagicLinkTokenEntity = TrainerOS.Domain.Entities.MagicLinkToken;

namespace TrainerOS.Tests;

public class VerifyEndpointTests : IClassFixture<MagicLinkTestApp>
{
    private readonly MagicLinkTestApp _app;

    public VerifyEndpointTests(MagicLinkTestApp app)
    {
        _app = app;
        _app.Clock.Now = FakeClock.BaseNow;
    }

    /// <summary>Mints a token row the way #20 does, returning the raw token.</summary>
    private string MintToken(Guid userId, TimeSpan? age = null, bool used = false)
    {
        var raw = MagicLinkTokens.NewRawToken();
        _app.WithDb(db =>
        {
            db.Add(new MagicLinkTokenEntity
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                TokenHash = MagicLinkTokens.Hash(raw),
                ExpiresAt = FakeClock.BaseNow - (age ?? TimeSpan.Zero) + MagicLinkTokens.Lifetime,
                UsedAt = used ? FakeClock.BaseNow : null,
            });
            return db.SaveChanges();
        });
        return raw;
    }

    private Task<HttpResponseMessage> GetVerify(string token)
        => _app.Client.GetAsync($"/api/auth/verify?token={token}");

    private Task<HttpResponseMessage> PostVerify(string token)
        => _app.Client.PostAsJsonAsync("/api/auth/verify", new { token });

    private static Guid SessionIdFromCookie(string setCookie)
        => Guid.Parse(setCookie.Split(';')[0].Split('=')[1]);

    private static async Task<bool> ValidFlag(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("valid").GetBoolean();
    }

    [Fact]
    public async Task Get_reports_valid_but_mutates_nothing_token_stays_usable()
    {
        var raw = MintToken(_app.ClientUserId);
        var sessionsBefore = _app.WithDb(db => db.Sessions.Count());

        // The mail-scanner scenario: the link is GET-prefetched (twice, even) before the user taps.
        var first = await GetVerify(raw);
        var second = await GetVerify(raw);

        Assert.True(await ValidFlag(first));
        Assert.True(await ValidFlag(second));
        Assert.False(first.Headers.Contains("Set-Cookie"), "GET must not create a session");
        Assert.Equal(sessionsBefore, _app.WithDb(db => db.Sessions.Count()));
        var row = _app.WithDb(db => db.MagicLinkTokens.Single(t => t.TokenHash == MagicLinkTokens.Hash(raw)));
        Assert.Null(row.UsedAt);

        // The token survives the prefetches: the user's actual POST still logs in.
        var consume = await PostVerify(raw);
        Assert.Equal(HttpStatusCode.OK, consume.StatusCode);
    }

    [Fact]
    public async Task Get_reports_invalid_for_garbage_expired_and_used_tokens()
    {
        Assert.False(await ValidFlag(await GetVerify("garbage-token")));
        Assert.False(await ValidFlag(await GetVerify(MintToken(_app.ClientUserId, age: TimeSpan.FromMinutes(16)))));
        Assert.False(await ValidFlag(await GetVerify(MintToken(_app.ClientUserId, used: true))));
    }

    [Fact]
    public async Task Post_consumes_creates_client_session_and_sets_cookie()
    {
        var raw = MintToken(_app.ClientUserId);

        var response = await PostVerify(raw);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var setCookie = Assert.Single(response.Headers.GetValues("Set-Cookie"));
        Assert.StartsWith($"{SessionCookie.Name}=", setCookie);
        Assert.Contains("httponly", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=lax", setCookie, StringComparison.OrdinalIgnoreCase);

        var row = _app.WithDb(db => db.MagicLinkTokens.Single(t => t.TokenHash == MagicLinkTokens.Hash(raw)));
        Assert.Equal(FakeClock.BaseNow, row.UsedAt);

        var sessionId = SessionIdFromCookie(setCookie);
        var session = _app.WithDb(db => db.Sessions.Single(s => s.Id == sessionId));
        Assert.Equal(_app.ClientUserId, session.UserId);
        Assert.Equal(FakeClock.BaseNow + SessionService.ClientLifetime, session.ExpiresAt);
    }

    [Fact]
    public async Task Post_trainer_token_creates_30_day_trainer_session()
    {
        // Per #20: magic link doubles as the trainer's password recovery.
        var raw = MintToken(_app.TrainerUserId);

        var response = await PostVerify(raw);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var setCookie = Assert.Single(response.Headers.GetValues("Set-Cookie"));
        var sessionId = SessionIdFromCookie(setCookie);
        var session = _app.WithDb(db => db.Sessions.Single(s => s.Id == sessionId));
        Assert.Equal(_app.TrainerUserId, session.UserId);
        Assert.Equal(FakeClock.BaseNow + SessionService.TrainerLifetime, session.ExpiresAt);
    }

    [Fact]
    public async Task Post_is_single_use_second_attempt_gets_401()
    {
        var raw = MintToken(_app.ClientUserId);
        Assert.Equal(HttpStatusCode.OK, (await PostVerify(raw)).StatusCode);
        var sessionsAfterFirst = _app.WithDb(db => db.Sessions.Count());

        var second = await PostVerify(raw);

        Assert.Equal(HttpStatusCode.Unauthorized, second.StatusCode);
        var body = await second.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("invalid_token", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(sessionsAfterFirst, _app.WithDb(db => db.Sessions.Count()));
    }

    [Fact]
    public async Task Post_expired_token_gets_401_and_no_session()
    {
        var raw = MintToken(_app.ClientUserId, age: TimeSpan.FromMinutes(16));
        var sessionsBefore = _app.WithDb(db => db.Sessions.Count());

        var response = await PostVerify(raw);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal(sessionsBefore, _app.WithDb(db => db.Sessions.Count()));
    }

    [Fact]
    public async Task Post_blank_token_gets_400()
    {
        var response = await PostVerify("   ");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("bad_request", body.GetProperty("error").GetProperty("code").GetString());
    }
}
