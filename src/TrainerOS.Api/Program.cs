using Microsoft.EntityFrameworkCore;
using Microsoft.OpenApi.Models;
using Npgsql;
using TrainerOS.Api;
using TrainerOS.Api.Auth;
using TrainerOS.Api.Endpoints;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Notifications;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddNpgsqlDataSource(builder.Configuration.GetConnectionString("Postgres")!);
builder.Services.AddDbContext<TrainerOsDbContext>((provider, options) =>
    options.UseNpgsql(provider.GetRequiredService<NpgsqlDataSource>()));
builder.Services.AddApiConventions();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddScoped<SessionService>();
builder.Services.AddAuthRateLimiting();

// Production binds the Resend sender under epic #6; until then only dev can send.
if (builder.Environment.IsDevelopment())
{
    builder.Services.AddSingleton<INotificationSender, ConsoleNotificationSender>();
}

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(o =>
    o.SwaggerDoc("v1", new OpenApiInfo { Title = "TrainerOS API", Version = "v1" }));

var app = builder.Build();

if (!app.Environment.IsDevelopment() && app.Services.GetService<INotificationSender>() is null)
{
    throw new InvalidOperationException(
        "No INotificationSender registered. Non-Development environments require the production "
        + "sender binding (Resend, issue #34) — refusing to start with email silently unwired.");
}

await TrainerSeeder.SeedAsync(app.Services, app.Configuration);

app.UseApiErrorHandling();
// Before session auth: rate-limited requests shouldn't cost a session lookup.
app.UseRateLimiter();
app.UseMiddleware<SessionAuthMiddleware>();

// OpenAPI description exists for TS type generation only (issue #14);
// public OpenAPI docs remain a non-goal per api.md — never exposed outside Development.
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
}

var api = app.MapGroup("/api");

api.MapAuthEndpoints();
api.MapClientEndpoints();
api.MapExerciseEndpoints();

api.MapGet("/health", async (NpgsqlDataSource db, CancellationToken ct) =>
{
    try
    {
        await using var cmd = db.CreateCommand("SELECT 1");
        await cmd.ExecuteScalarAsync(ct);
        return Results.Ok(new { database = "connected" });
    }
    catch (NpgsqlException)
    {
        return Results.Json(new { database = "unreachable" }, statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

app.Run();

public partial class Program;
