using System.Net.Mail;

using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

namespace TrainerOS.Api.Endpoints;

// api.md §Trainer endpoints: the client-roster surface. Every route is trainer-only and
// scoped through ClientsForTrainer / WorkoutSessionsForTrainer — the URL id is a filter,
// not a lookup key, so a foreign trainer's client id is a 404 like a made-up one.
public static class ClientEndpoints
{
    public sealed record CreateClientRequest(string? Email, string? DisplayName, string? Timezone);
    public sealed record UpdateClientRequest(string? DisplayName, string? Timezone, bool? IsActive);

    public sealed record ClientResponse(
        Guid Id,
        string Email,
        string DisplayName,
        string Timezone,
        bool IsActive,
        DateTimeOffset CreatedAt);

    public sealed record ClientSessionResponse(
        Guid Id,
        DateOnly PerformedOn,
        Guid? ProgramDayId,
        string? Comment,
        DateTimeOffset CreatedAt);

    public static RouteGroupBuilder MapClientEndpoints(this RouteGroupBuilder api)
    {
        var clients = api.MapGroup("/clients").RequireTrainer();
        clients.MapGet("", ListClients);
        clients.MapPost("", CreateClient);
        clients.MapPatch("/{id:guid}", UpdateClient);
        clients.MapGet("/{id:guid}/sessions", ListClientSessions);
        return api;
    }

    private static async Task<IResult> ListClients(
        HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var rows = await db.ClientsForTrainer(trainer.Id)
            .OrderBy(u => u.DisplayName)
            .Select(u => new ClientResponse(u.Id, u.Email, u.DisplayName, u.Timezone, u.IsActive, u.CreatedAt))
            .AsNoTracking()
            .ToListAsync(cancellationToken);

        return Results.Ok(rows);
    }

    // api.md: "sends nothing (invite = trainer tells them to log in via magic link)".
    // No INotificationSender interaction here on purpose — this endpoint has no email side effect.
    private static async Task<IResult> CreateClient(
        CreateClientRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        TimeProvider clock,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var email = body.Email?.Trim();
        var displayName = body.DisplayName?.Trim();
        var timezone = body.Timezone?.Trim();

        if (string.IsNullOrEmpty(email)
            || string.IsNullOrEmpty(displayName)
            || string.IsNullOrEmpty(timezone))
        {
            return Results.BadRequest(
                ApiError.Create("bad_request", "email, display_name, and timezone are required."));
        }

        if (!MailAddress.TryCreate(email, out _))
        {
            return Results.BadRequest(ApiError.Create("bad_request", "email is not a valid address."));
        }

        if (!TimeZoneInfo.TryFindSystemTimeZoneById(timezone, out _))
        {
            return Results.BadRequest(
                ApiError.Create("bad_request", $"'{timezone}' is not a recognized IANA timezone."));
        }

        // Pre-check on the citext-unique email index. The DbUpdateException catch below
        // is the honest backstop for the race between check and insert.
        var conflict = await db.UserByEmail(email).AnyAsync(cancellationToken);
        if (conflict)
        {
            return EmailTaken();
        }

        var client = new User
        {
            Id = Guid.NewGuid(),
            Role = Roles.Client,
            Email = email,
            DisplayName = displayName,
            TrainerId = trainer.Id,
            Timezone = timezone,
            IsActive = true,
            CreatedAt = clock.GetUtcNow(),
        };
        db.Add(client);

        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException)
        {
            return EmailTaken();
        }

        var response = new ClientResponse(
            client.Id, client.Email, client.DisplayName, client.Timezone, client.IsActive, client.CreatedAt);
        return Results.Created($"/api/clients/{client.Id}", response);

        static IResult EmailTaken() => Results.Json(
            ApiError.Create("email_taken", "A user with this email already exists."),
            statusCode: StatusCodes.Status409Conflict);
    }

    private static async Task<IResult> UpdateClient(
        Guid id,
        UpdateClientRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var displayName = body.DisplayName?.Trim();
        var timezone = body.Timezone?.Trim();

        if (body.DisplayName is not null && string.IsNullOrEmpty(displayName))
        {
            return Results.BadRequest(ApiError.Create("bad_request", "display_name cannot be blank."));
        }

        if (body.Timezone is not null)
        {
            if (string.IsNullOrEmpty(timezone))
            {
                return Results.BadRequest(ApiError.Create("bad_request", "timezone cannot be blank."));
            }

            if (!TimeZoneInfo.TryFindSystemTimeZoneById(timezone, out _))
            {
                return Results.BadRequest(
                    ApiError.Create("bad_request", $"'{timezone}' is not a recognized IANA timezone."));
            }
        }

        var client = await db.ClientsForTrainer(trainer.Id)
            .FirstOrDefaultAsync(u => u.Id == id, cancellationToken);
        if (client is null)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        var deactivating = body.IsActive == false && client.IsActive;

        // AC: is_active=false also disables notification schedules in a single transaction.
        // Ordinary edits skip the transaction — the user update alone is atomic.
        await using var transaction = deactivating
            ? await db.Database.BeginTransactionAsync(cancellationToken)
            : null;

        if (displayName is not null)
        {
            client.DisplayName = displayName;
        }

        if (timezone is not null)
        {
            client.Timezone = timezone;
        }

        if (body.IsActive is not null)
        {
            client.IsActive = body.IsActive.Value;
        }

        await db.SaveChangesAsync(cancellationToken);

        if (deactivating)
        {
            await db.NotificationSchedulesForTrainer(trainer.Id)
                .Where(s => s.ClientId == client.Id && s.Enabled)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.Enabled, false), cancellationToken);

            await transaction!.CommitAsync(cancellationToken);
        }

        var response = new ClientResponse(
            client.Id, client.Email, client.DisplayName, client.Timezone, client.IsActive, client.CreatedAt);
        return Results.Ok(response);
    }

    private static async Task<IResult> ListClientSessions(
        Guid id, HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        // Existence check via the trainer-scoped client roster: a client id belonging to
        // another trainer collapses to the same 404 as a fabricated id (api.md §Authorization pt 2).
        var clientExists = await db.ClientsForTrainer(trainer.Id)
            .AnyAsync(u => u.Id == id, cancellationToken);
        if (!clientExists)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        var sessions = await db.WorkoutSessionsForTrainer(trainer.Id)
            .Where(s => s.ClientId == id)
            .OrderByDescending(s => s.PerformedOn)
            .Select(s => new ClientSessionResponse(
                s.Id, s.PerformedOn, s.ProgramDayId, s.Comment, s.CreatedAt))
            .AsNoTracking()
            .ToListAsync(cancellationToken);

        return Results.Ok(sessions);
    }
}
