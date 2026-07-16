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

public sealed record EchoBody(string Name, DateTime? At);

// Hosts the conventions in a throwaway app with probe endpoints, since the real
// API has no body-accepting or throwing routes yet to exercise them through.
public sealed class ConventionsTestApp : IAsyncLifetime
{
    private WebApplication _app = null!;

    public HttpClient Client { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddApiConventions();

        _app = builder.Build();
        _app.UseApiErrorHandling();

        var api = _app.MapGroup("/api");
        api.MapPost("/echo", (EchoBody body) => Results.Ok(body));
        api.MapGet("/boom", string () => throw new InvalidOperationException("secret internal detail"));
        api.MapGet("/timestamps", () => new
        {
            Utc = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc),
            Unspecified = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Unspecified),
            Offset = new DateTimeOffset(2026, 1, 2, 5, 4, 5, TimeSpan.FromHours(2)),
        });

        await _app.StartAsync();
        Client = _app.GetTestClient();
    }

    public async Task DisposeAsync() => await _app.DisposeAsync();
}

public class ApiConventionsTests : IClassFixture<ConventionsTestApp>
{
    private readonly HttpClient _client;

    public ApiConventionsTests(ConventionsTestApp app) => _client = app.Client;

    private static void AssertErrorShape(JsonElement body, string expectedCode)
    {
        Assert.Single(body.EnumerateObject());
        var error = body.GetProperty("error");
        Assert.Equal(2, error.EnumerateObject().Count());
        Assert.Equal(expectedCode, error.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(error.GetProperty("message").GetString()));
    }

    [Fact]
    public async Task Unknown_field_in_body_is_rejected_with_error_shape()
    {
        var response = await _client.PostAsJsonAsync("/api/echo", new { name = "a", bogus = 1 });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        AssertErrorShape(body, "bad_request");
        Assert.Contains("bogus", body.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Valid_body_is_accepted()
    {
        var response = await _client.PostAsJsonAsync("/api/echo", new { name = "a" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Malformed_json_is_rejected_with_error_shape()
    {
        var response = await _client.PostAsync("/api/echo",
            new StringContent("{not json", System.Text.Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        AssertErrorShape(body, "bad_request");
    }

    [Fact]
    public async Task Unhandled_exception_returns_error_shape_without_leaking_details()
    {
        var response = await _client.GetAsync("/api/boom");

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("secret internal detail", raw);
        Assert.DoesNotContain("InvalidOperationException", raw);
        Assert.DoesNotContain("   at ", raw);
        AssertErrorShape(JsonDocument.Parse(raw).RootElement, "internal_error");
    }

    [Fact]
    public async Task Unmatched_route_returns_404_with_error_shape()
    {
        var response = await _client.GetAsync("/api/nope");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        AssertErrorShape(body, "not_found");
    }

    [Fact]
    public async Task Timestamps_are_serialized_as_utc_iso8601()
    {
        var body = await _client.GetFromJsonAsync<JsonElement>("/api/timestamps");

        Assert.Equal("2026-01-02T03:04:05Z", body.GetProperty("utc").GetString());
        Assert.Equal("2026-01-02T03:04:05Z", body.GetProperty("unspecified").GetString());
        Assert.Equal("2026-01-02T03:04:05+00:00", body.GetProperty("offset").GetString());
    }

    [Fact]
    public async Task Timestamps_are_normalized_to_utc_on_the_way_in()
    {
        var response = await _client.PostAsJsonAsync("/api/echo",
            new { name = "a", at = "2026-01-02T05:04:05+02:00" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("2026-01-02T03:04:05Z", body.GetProperty("at").GetString());
    }
}

public class ApiBasePathTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public ApiBasePathTests(WebApplicationFactory<Program> factory)
        => _factory = factory.WithWebHostBuilder(builder => builder.UseSetting(
            "ConnectionStrings:Postgres",
            "Host=localhost;Port=1;Database=x;Username=x;Password=x;Timeout=1"));

    [Fact]
    public async Task Health_lives_under_api_base_path()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/health");

        Assert.NotEqual(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Routes_outside_api_base_path_do_not_exist()
    {
        var client = _factory.CreateClient();

        foreach (var path in new[] { "/health", "/" })
        {
            var response = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        }
    }
}
