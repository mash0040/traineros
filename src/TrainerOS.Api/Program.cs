using Microsoft.OpenApi.Models;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddNpgsqlDataSource(builder.Configuration.GetConnectionString("Postgres")!);

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(o =>
    o.SwaggerDoc("v1", new OpenApiInfo { Title = "TrainerOS API", Version = "v1" }));

var app = builder.Build();

// OpenAPI description exists for TS type generation only (issue #14);
// public OpenAPI docs remain a non-goal per api.md — never exposed outside Development.
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
}

app.MapGet("/", () => "Hello World!");

app.MapGet("/health", async (NpgsqlDataSource db, CancellationToken ct) =>
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
