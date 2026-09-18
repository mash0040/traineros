using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using TrainerOS.Api;

namespace TrainerOS.Tests;

// #158: `www.` is redirected to the apex so there is one origin holding one session cookie.
// The host is the whole input here, so the fixture keeps a counter of how many requests
// reached the terminal endpoint — that is what lets a test assert a request was *stopped*
// rather than merely answered with a 301 after doing the work anyway.
public sealed class CanonicalHostTestApp : IAsyncLifetime
{
    private WebApplication _app = null!;

    public HttpClient Client { get; private set; } = null!;

    public int DownstreamHits { get; private set; }

    public async Task InitializeAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();

        _app = builder.Build();
        _app.UseCanonicalHost();
        _app.Use(async (context, next) =>
        {
            DownstreamHits++;
            await next();
        });
        _app.MapGet("/{**rest}", () => Results.Text("downstream", "text/plain"));

        await _app.StartAsync();

        // TestServer's handler follows redirects on its own, which would resolve every 301
        // below into a second request and hide the Location this suite exists to assert.
        var handler = _app.GetTestServer().CreateHandler();
        Client = new HttpClient(handler) { BaseAddress = new Uri("http://traineros.me") };
    }

    public void ResetHits() => DownstreamHits = 0;

    public async Task DisposeAsync() => await _app.DisposeAsync();
}

public class CanonicalHostTests(CanonicalHostTestApp app) : IClassFixture<CanonicalHostTestApp>
{
    private readonly CanonicalHostTestApp _app = app;

    private HttpClient Client => _app.Client;

    // The whole point: path and query survive, so a magic link or a deep link opened at the
    // `www.` host lands on the same screen at the apex rather than at the site root.
    [Theory]
    [InlineData("http://www.traineros.me/", "https://traineros.me/")]
    [InlineData("http://www.traineros.me/workout?day=day-1", "https://traineros.me/workout?day=day-1")]
    [InlineData("http://www.traineros.me/verify?token=abc123", "https://traineros.me/verify?token=abc123")]
    [InlineData("http://www.traineros.me/api/health", "https://traineros.me/api/health")]
    [InlineData("http://www.traineros.me/history", "https://traineros.me/history")]
    public async Task Www_host_is_redirected_to_the_apex(string requested, string expected)
    {
        var response = await Client.GetAsync(requested);

        Assert.Equal(HttpStatusCode.MovedPermanently, response.StatusCode);
        Assert.Equal(expected, response.Headers.Location?.ToString());
    }

    // (No test pins the case-insensitivity of the `www.` match: both HttpClient and TestServer
    // normalize the host to lowercase before any middleware sees it, so such a test would
    // assert on an input it cannot actually vary. The OrdinalIgnoreCase comparison stands on
    // hostnames being case-insensitive per RFC 4343, not on a test that proves nothing.)

    // Azure terminates TLS at the front end and forwards over plain HTTP with no
    // ForwardedHeaders middleware in this app, so an echoed scheme would send an HTTPS
    // visitor to http:// on an HTTPS-only site.
    [Fact]
    public async Task Redirect_target_is_https_even_though_the_inbound_request_is_plain_http()
    {
        var response = await Client.GetAsync("http://www.traineros.me/clients");

        Assert.Equal("https", response.Headers.Location?.Scheme);
    }

    // The deploy pipeline's smoke check requests this host and asserts the SPA shell comes
    // back as text/html. A redirect here fails every deploy.
    [Theory]
    [InlineData("http://app-traineros.azurewebsites.net/")]
    [InlineData("http://app-traineros.azurewebsites.net/api/health")]
    public async Task Smoke_check_host_is_never_redirected(string requested)
    {
        var response = await Client.GetAsync(requested);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null(response.Headers.Location);
    }

    [Theory]
    [InlineData("http://traineros.me/")]
    [InlineData("http://traineros.me/workout?day=day-1")]
    [InlineData("http://localhost/")]
    [InlineData("http://localhost:5173/api/health")]
    public async Task Canonical_and_local_hosts_pass_through(string requested)
    {
        var response = await Client.GetAsync(requested);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null(response.Headers.Location);
    }

    // `www.` is a prefix, not a substring: a host that merely contains those letters is a
    // different site, and stripping them would point the visitor somewhere that isn't ours.
    [Theory]
    [InlineData("http://wwwtraineros.me/")]
    [InlineData("http://mywww.traineros.me/")]
    public async Task Hosts_that_only_contain_www_are_not_redirected(string requested)
    {
        var response = await Client.GetAsync(requested);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null(response.Headers.Location);
    }

    // The port has to survive, or a redirect in any non-443 environment sends the browser to
    // a host that isn't listening.
    [Fact]
    public async Task Port_is_preserved_when_the_request_carries_one()
    {
        var response = await Client.GetAsync("http://www.localhost:5173/history");

        Assert.Equal(HttpStatusCode.MovedPermanently, response.StatusCode);
        Assert.Equal("http://localhost:5173/history", response.Headers.Location?.ToString());
    }

    // Placement, not just behaviour: the redirect is first in the pipeline, so a discarded
    // request never reaches the rate limiter, the static-file middleware, or a session lookup.
    [Fact]
    public async Task Redirected_request_is_stopped_before_anything_downstream_runs()
    {
        _app.ResetHits();

        var response = await Client.GetAsync("http://www.traineros.me/workout");

        Assert.Equal(HttpStatusCode.MovedPermanently, response.StatusCode);
        Assert.Equal(0, _app.DownstreamHits);
    }

    // Every method, not just the browser-shaped ones: a POST answered normally at `www.`
    // would mint a session cookie on the non-canonical host, which is the split-session bug
    // this closes.
    [Theory]
    [InlineData("POST")]
    [InlineData("PATCH")]
    [InlineData("DELETE")]
    public async Task Non_get_methods_are_redirected_too(string method)
    {
        var request = new HttpRequestMessage(
            new HttpMethod(method), "http://www.traineros.me/api/me");

        var response = await Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.MovedPermanently, response.StatusCode);
        Assert.Equal("https://traineros.me/api/me", response.Headers.Location?.ToString());
    }
}
