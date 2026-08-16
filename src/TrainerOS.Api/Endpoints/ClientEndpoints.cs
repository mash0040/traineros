using Microsoft.AspNetCore.Mvc;
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
    // Same page size and ceiling as GET /api/me/history. The two routes return the same rows in
    // the same shape, so a trainer paging through a client's log and the client paging through
    // their own should not be reading different-sized pages.
    private const int DefaultHistoryLimit = 20;
    private const int MaxHistoryLimit = 100;

    public sealed record CreateClientRequest(
        string? Email, string? DisplayName, string? Timezone, string? WeightUnit);

    public sealed record UpdateClientRequest(
        string? DisplayName, string? Timezone, bool? IsActive, string? WeightUnit);

    public sealed record ClientResponse(
        Guid Id,
        string Email,
        string DisplayName,
        string Timezone,
        string WeightUnit,
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
        clients.MapGet("", ListClients)
            .Produces<List<ClientResponse>>();
        clients.MapPost("", CreateClient)
            .Produces<ClientResponse>(StatusCodes.Status201Created);
        clients.MapPatch("/{id:guid}", UpdateClient)
            .Produces<ClientResponse>();
        clients.MapGet("/{id:guid}/sessions", ListClientSessions)
            .Produces<List<ClientSessionResponse>>();
        clients.MapGet("/{id:guid}/history", GetClientHistory)
            .Produces<HistoryResponse>();
        return api;
    }

    private static async Task<IResult> ListClients(
        HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var rows = await db.ClientsForTrainer(trainer.Id)
            .OrderBy(u => u.DisplayName)
            .Select(u => new ClientResponse(
                u.Id, u.Email, u.DisplayName, u.Timezone, u.WeightUnit, u.IsActive, u.CreatedAt))
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

        // #114: this used to be MailAddress.TryCreate directly, which parses mailbox syntax
        // rather than a bare address and so let "Ada <ada@example.com>" through to be stored
        // verbatim. See EmailAddresses for what that broke and why the round-trip check is
        // the fix. The stakes are high here specifically because email is write-once: there
        // is no field on UpdateClientRequest to correct a typo with, so an address that gets
        // past this point is wrong until someone deletes the row in the database.
        if (!EmailAddresses.IsValid(email))
        {
            // Worded identically to the SPA's own client-side check (web/src/screens/
            // ClientsScreen.tsx). The two rules deliberately differ in strictness — the client
            // one is looser and lets some inputs through to be refused here — so the trainer
            // can see the same rejection from either layer for what is, to them, one mistake.
            // If this string changes, that one changes with it.
            return Results.BadRequest(
                ApiError.Create("bad_request", "Please enter a valid email address."));
        }

        if (!TimeZoneInfo.TryFindSystemTimeZoneById(timezone, out _))
        {
            return Results.BadRequest(
                ApiError.Create("bad_request", $"'{timezone}' is not a recognized IANA timezone."));
        }

        // Optional on create (#99): omitted means the default, which is what the trainer wants
        // in the overwhelming majority of cases. Sent-but-wrong is still a 400 — silently
        // falling back to lb for a client the trainer said thinks in kg is the worse failure.
        var weightUnit = WeightUnits.Default;
        if (body.WeightUnit is not null)
        {
            if (WeightUnits.Normalize(body.WeightUnit) is not { } normalized)
            {
                return Results.BadRequest(InvalidWeightUnit());
            }
            weightUnit = normalized;
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
            WeightUnit = weightUnit,
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
            client.Id, client.Email, client.DisplayName, client.Timezone, client.WeightUnit,
            client.IsActive, client.CreatedAt);
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

        // The trainer sets the default when adding a client and can correct it here; the client
        // corrects it for themselves through PATCH /api/me. Two writers, one column, and no
        // ordering problem — whoever wrote last is right, because both of them are answering
        // the same question about the same person.
        string? weightUnit = null;
        if (body.WeightUnit is not null)
        {
            weightUnit = WeightUnits.Normalize(body.WeightUnit);
            if (weightUnit is null)
            {
                return Results.BadRequest(InvalidWeightUnit());
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

        if (weightUnit is not null)
        {
            client.WeightUnit = weightUnit;
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
            client.Id, client.Email, client.DisplayName, client.Timezone, client.WeightUnit,
            client.IsActive, client.CreatedAt);
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

    // #142. What the client actually lifted, for their trainer.
    //
    // ── Why this is not GET /api/clients/:id/sessions with sets nested in it ───────────────
    // That route has a second consumer: the roster reads it once per client for the last-session
    // date, and ClientsScreen already documents what that costs — "reading one date downloads
    // every session that client has ever logged". Nesting sets into it would multiply that by
    // every set of every session, for every client on the roster, to render one date. So the
    // sets get their own route and /sessions is left alone.
    //
    // ── Why the page is flat sets rather than sessions with nested sets ───────────────────
    // It is the shape GET /api/me/history already returns (#33), and these are the same rows.
    // See HistoryViews.cs. The grouping both screens render lives in the SPA's lib/history.ts,
    // which already solves the part that is hard — pagination counts sets while the screen
    // renders sessions, so a page can end mid-workout.
    //
    // ── Scoping, twice ─────────────────────────────────────────────────────────────────────
    // The existence check goes through ClientsForTrainer, so another trainer's client id is the
    // same 404 as a fabricated one (api.md §Authorization pt 2). The sets themselves come
    // through LoggedSetsForTrainer, so even a bug in the check above could not return rows
    // belonging to another trainer — ownership is in the WHERE clause, not in a guard.
    private static async Task<IResult> GetClientHistory(
        Guid id,
        [FromQuery(Name = "before")] DateTimeOffset? before,
        [FromQuery(Name = "limit")] int? limit,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var trainer = http.GetCurrentUser()!;

        var pageSize = limit ?? DefaultHistoryLimit;
        if (pageSize <= 0 || pageSize > MaxHistoryLimit)
        {
            return Results.BadRequest(ApiError.Create(
                "bad_request", $"limit must be between 1 and {MaxHistoryLimit}."));
        }

        var clientExists = await db.ClientsForTrainer(trainer.Id)
            .AnyAsync(u => u.Id == id, cancellationToken);
        if (!clientExists)
        {
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        var query = db.LoggedSetsForTrainer(trainer.Id).Where(s => s.Session.ClientId == id);
        if (before is { } cursor)
        {
            query = query.Where(s => s.LoggedAt < cursor);
        }

        var rows = await query
            .OrderByDescending(s => s.LoggedAt)
            .Take(pageSize)
            .Select(s => new
            {
                s.Id,
                s.SetNumber,
                s.WeightKg,
                s.Reps,
                s.LoggedAt,
                SessionId = s.Session.Id,
                SessionPerformedOn = s.Session.PerformedOn,
                SessionComment = s.Session.Comment,
                SessionProgramDayId = s.Session.ProgramDayId,
                s.ExerciseId,
            })
            .AsNoTracking()
            .ToListAsync(cancellationToken);

        // Second query rather than a per-row join, matching GET /api/me/history: two round
        // trips, and the exercise index takes a page's-worth of keys in one WHERE id IN (…).
        // Scoped to the trainer's own library, which is where these exercises are by
        // construction — a client's sets can only name exercises their trainer prescribed.
        var exerciseIds = rows.Select(r => r.ExerciseId).Distinct().ToList();
        var exerciseNames = exerciseIds.Count == 0
            ? new Dictionary<Guid, string>()
            : await db.ExercisesForTrainer(trainer.Id)
                .Where(e => exerciseIds.Contains(e.Id))
                .Select(e => new { e.Id, e.Name })
                .AsNoTracking()
                .ToDictionaryAsync(e => e.Id, e => e.Name, cancellationToken);

        var items = rows.Select(r => new HistoryItem(
            r.Id, r.SetNumber, r.WeightKg, r.Reps, r.LoggedAt,
            new HistorySessionSummary(
                r.SessionId, r.SessionPerformedOn, r.SessionComment, r.SessionProgramDayId),
            new HistoryExerciseRef(r.ExerciseId, exerciseNames.GetValueOrDefault(r.ExerciseId, ""))
        )).ToList();

        var nextCursor = items.Count == pageSize ? items[^1].LoggedAt : (DateTimeOffset?)null;

        return Results.Ok(new HistoryResponse(items, nextCursor));
    }

    // One sentence for both write paths, so a trainer sending a bad unit to POST and to PATCH
    // reads the same refusal. Worded identically to PATCH /api/me's, for the same reason the
    // email rule is worded identically to the SPA's: it is one mistake, whoever catches it.
    private static ApiError InvalidWeightUnit()
        => ApiError.Create("bad_request", "weight_unit must be 'kg' or 'lb'.");
}
