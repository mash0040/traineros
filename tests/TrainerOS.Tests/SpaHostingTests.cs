using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using TrainerOS.Api;

namespace TrainerOS.Tests;

// Hosts the SPA wiring over a throwaway wwwroot, since the real one is produced by the deploy
// pipeline (#57) and is empty in a source checkout.
public sealed class SpaHostingTestApp : IAsyncLifetime
{
    private readonly string _webRoot =
        Path.Combine(Path.GetTempPath(), $"traineros-wwwroot-{Guid.NewGuid():N}");

    private WebApplication _app = null!;

    public HttpClient Client { get; private set; } = null!;

    public const string ShellMarker = "<div id=\"root\"></div>";

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(Path.Combine(_webRoot, "assets"));
        await File.WriteAllTextAsync(Path.Combine(_webRoot, "index.html"),
            $"<!doctype html><html><body>{ShellMarker}</body></html>");
        await File.WriteAllTextAsync(Path.Combine(_webRoot, "assets", "index-abc123.js"),
            "export const build = 'hashed';");

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { WebRootPath = _webRoot });
        builder.WebHost.UseTestServer();
        builder.Services.AddApiConventions();

        _app = builder.Build();
        _app.UseApiErrorHandling();
        _app.UseSpaHosting();
        _app.MapGroup("/api").MapGet("/health", () => Results.Ok(new { database = "connected" }));

        await _app.StartAsync();
        Client = _app.GetTestClient();
    }

    public async Task DisposeAsync()
    {
        await _app.DisposeAsync();
        Directory.Delete(_webRoot, recursive: true);
    }
}

public class SpaHostingTests(SpaHostingTestApp app) : IClassFixture<SpaHostingTestApp>
{
    private readonly HttpClient _client = app.Client;

    [Theory]
    [InlineData("/")]
    [InlineData("/verify")]
    [InlineData("/pause")]
    [InlineData("/clients/8a1f0f6e-3f0e-4a1e-9e2b-6d1c9d4f7b21")]
    public async Task Client_routes_return_the_spa_shell(string path)
    {
        var response = await _client.GetAsync(path);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains(SpaHostingTestApp.ShellMarker, await response.Content.ReadAsStringAsync());
    }

    // The one that matters: the fallback must not swallow API 404s, or a mistyped route comes
    // back as HTML with a 200 and the client fails on JSON.parse instead of on the status.
    [Fact]
    public async Task Unmatched_api_route_returns_the_json_error_envelope_not_the_shell()
    {
        var response = await _client.GetAsync("/api/nope");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("not_found", body.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact]
    public async Task Api_routes_still_reach_their_endpoint()
    {
        var response = await _client.GetAsync("/api/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("connected", body.GetProperty("database").GetString());
    }

    [Fact]
    public async Task Hashed_assets_are_served_immutably()
    {
        var response = await _client.GetAsync("/assets/index-abc123.js");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("public, max-age=31536000, immutable", response.Headers.CacheControl?.ToString());
    }

    // A cached shell would keep requesting the previous deploy's bundle names, which no longer
    // exist — a blank app that no redeploy fixes.
    [Fact]
    public async Task Spa_shell_is_not_cached()
    {
        var response = await _client.GetAsync("/verify");

        Assert.Equal("no-cache", response.Headers.CacheControl?.ToString());
    }

    [Fact]
    public async Task Missing_asset_is_a_404_rather_than_the_shell()
    {
        var response = await _client.GetAsync("/assets/gone-000000.js");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.DoesNotContain(SpaHostingTestApp.ShellMarker, await response.Content.ReadAsStringAsync());
    }
}
