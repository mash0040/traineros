using Npgsql;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddNpgsqlDataSource(builder.Configuration.GetConnectionString("Postgres")!);

var app = builder.Build();

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
