using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TrainerOS.Tests;

// Email-limit and IP-limit tests live in separate classes on purpose: each class gets its
// own MagicLinkTestApp (and thus fresh in-memory limiter state), so one suite's requests
// can't eat the other's budget.
public class MagicLinkEmailRateLimitTests : IClassFixture<MagicLinkTestApp>
{
    private readonly MagicLinkTestApp _app;

    public MagicLinkEmailRateLimitTests(MagicLinkTestApp app) => _app = app;

    private Task<HttpResponseMessage> Post(string email, string ip)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/auth/magic-link")
        {
            Content = JsonContent.Create(new { email }),
        };
        request.Headers.Add(MagicLinkTestApp.TestClientIpHeader, ip);
        return _app.Client.SendAsync(request);
    }

    private static async Task AssertRateLimited(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("rate_limited", body.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Fourth_request_for_same_email_gets_429_other_emails_unaffected()
    {
        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(HttpStatusCode.Accepted,
                (await Post(MagicLinkTestApp.ClientEmail, "10.1.0.1")).StatusCode);
        }

        await AssertRateLimited(await Post(MagicLinkTestApp.ClientEmail, "10.1.0.1"));

        // The window is per email, not per IP: a different email from the same IP still passes.
        Assert.Equal(HttpStatusCode.Accepted,
            (await Post("someone-else@example.com", "10.1.0.1")).StatusCode);
    }

    [Fact]
    public async Task Unknown_email_is_limited_identically_to_known_no_enumeration_oracle()
    {
        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(HttpStatusCode.Accepted,
                (await Post("nobody-here@example.com", "10.1.0.2")).StatusCode);
        }

        var unknownLimited = await Post("nobody-here@example.com", "10.1.0.2");
        await AssertRateLimited(unknownLimited);

        for (var i = 0; i < 3; i++)
        {
            await Post(MagicLinkTestApp.TrainerEmail, "10.1.0.3");
        }

        var knownLimited = await Post(MagicLinkTestApp.TrainerEmail, "10.1.0.3");
        await AssertRateLimited(knownLimited);
        Assert.Equal(
            await unknownLimited.Content.ReadAsStringAsync(),
            await knownLimited.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Case_and_whitespace_variants_share_one_email_window()
    {
        Assert.Equal(HttpStatusCode.Accepted, (await Post("Mixed@Example.com", "10.1.0.4")).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await Post("mixed@example.com", "10.1.0.4")).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await Post("  MIXED@EXAMPLE.COM  ", "10.1.0.4")).StatusCode);

        await AssertRateLimited(await Post("mixed@example.com", "10.1.0.4"));
    }
}

public class AuthIpRateLimitTests : IClassFixture<MagicLinkTestApp>
{
    private readonly MagicLinkTestApp _app;

    public AuthIpRateLimitTests(MagicLinkTestApp app) => _app = app;

    private Task<HttpResponseMessage> Send(string path, object body, string ip)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.Add(MagicLinkTestApp.TestClientIpHeader, ip);
        return _app.Client.SendAsync(request);
    }

    [Fact]
    public async Task Eleventh_request_from_one_ip_gets_429_on_magic_link_and_login_other_ips_unaffected()
    {
        // Distinct emails per request keep the per-email window out of the picture.
        for (var i = 0; i < 10; i++)
        {
            Assert.Equal(HttpStatusCode.Accepted,
                (await Send("/api/auth/magic-link", new { email = $"user{i}@example.com" }, "10.2.0.1")).StatusCode);
        }

        var limited = await Send("/api/auth/magic-link", new { email = "user10@example.com" }, "10.2.0.1");
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
        var body = await limited.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("rate_limited", body.GetProperty("error").GetProperty("code").GetString());

        // Per IP, not global: another IP still passes.
        Assert.Equal(HttpStatusCode.Accepted,
            (await Send("/api/auth/magic-link", new { email = "user11@example.com" }, "10.2.0.2")).StatusCode);

        // Login shares the IP policy: the exhausted IP is rejected there too.
        var login = await Send("/api/auth/login", new { email = "x@example.com", password = "nope" }, "10.2.0.1");
        Assert.Equal(HttpStatusCode.TooManyRequests, login.StatusCode);
    }

    [Fact]
    public async Task Login_attempts_and_magic_link_requests_share_one_ip_window()
    {
        // Mixed traffic from one IP draws on a single 10/hour budget. Distinct emails
        // keep the per-email magic-link window out of the picture.
        for (var i = 0; i < 6; i++)
        {
            Assert.Equal(HttpStatusCode.Accepted,
                (await Send("/api/auth/magic-link", new { email = $"mixed{i}@example.com" }, "10.2.0.3")).StatusCode);
        }

        for (var i = 0; i < 4; i++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await Send("/api/auth/login", new { email = $"mixed{i}@example.com", password = "nope" }, "10.2.0.3")).StatusCode);
        }

        // Budget spent: request 11 is rejected regardless of which endpoint it hits.
        Assert.Equal(HttpStatusCode.TooManyRequests,
            (await Send("/api/auth/login", new { email = "mixed@example.com", password = "nope" }, "10.2.0.3")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests,
            (await Send("/api/auth/magic-link", new { email = "mixed@example.com" }, "10.2.0.3")).StatusCode);

        // Another IP's login window is untouched.
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await Send("/api/auth/login", new { email = "x@example.com", password = "nope" }, "10.2.0.4")).StatusCode);
    }
}
