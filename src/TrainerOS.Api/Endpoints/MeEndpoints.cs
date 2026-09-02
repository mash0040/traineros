using Microsoft.EntityFrameworkCore;

using TrainerOS.Api.Auth;
using TrainerOS.Domain.Data;
using TrainerOS.Domain.Entities;

namespace TrainerOS.Api.Endpoints;

// api.md §Client endpoints — the /api/me/* namespace. Every query scopes by
// session user (ProgramsForClient), never by trainer_id: the client's identity is
// the session cookie, and the URL never contains their own id, so the IDOR surface
// for client self-service is structurally zero.
public static class MeEndpoints
{
    public sealed record MeResponse(
        Guid Id,
        string Email,
        string DisplayName,
        string Timezone,
        string WeightUnit,
        ActiveProgramSummary? ActiveProgram);

    /// <summary>
    /// The client's own writable profile, and it is one field on purpose (#99).
    ///
    /// What is deliberately absent, so that widening this is a decision someone makes rather
    /// than one they inherit:
    ///
    ///   * <c>email</c> — it is the login identity *and* the reminder channel. A client editing
    ///     it would silently redirect their own magic links, and there is no recovery path
    ///     because the new address is where the recovery link would go.
    ///   * <c>timezone</c> — it exists to schedule reminders, which is the trainer's job
    ///     (notifications.md). A client changing it moves email they did not ask to move.
    ///   * <c>display_name</c> — trainer-owned; it is how the roster reads.
    ///   * <c>is_active</c> — a client must not be able to deactivate themselves, and must
    ///     certainly not be able to reactivate.
    ///
    /// Null means "don't touch", the same convention UpdateClientRequest uses.
    /// </summary>
    public sealed record UpdateMeRequest(Patch<string> WeightUnit);

    public sealed record ActiveProgramSummary(Guid Id, string Title, DateOnly? StartsOn);

    // Wrapper so "no active program" is 200 + { program: null }, mirroring how
    // GET /api/me expresses the same state as activeProgram: null. Both endpoints
    // give the SPA the same shape for the same condition — one endpoint semantic,
    // not two. 404 would force the caller to branch on "is this empty state or a
    // real not-found?" per endpoint.
    public sealed record MeProgramWrapper(MeProgramDetails? Program);

    // DayView / PrescriptionView / ExerciseView moved to ProgramTreeViews.cs in #78, when the
    // trainer's GET /api/programs/:id started returning the same tree. Shape unchanged.
    public sealed record MeProgramDetails(
        Guid Id,
        string Title,
        string Status,
        DateOnly? StartsOn,
        string? Notes,
        List<DayView> Days);

    public static RouteGroupBuilder MapMeEndpoints(this RouteGroupBuilder api)
    {
        var me = api.MapGroup("/me").RequireClient();
        me.MapGet("", GetMe)
            .Produces<MeResponse>();
        me.MapPatch("", UpdateMe)
            .Produces<MeResponse>();
        me.MapGet("/program", GetMyProgram)
            .Produces<MeProgramWrapper>();
        return api;
    }

    private static async Task<IResult> GetMe(
        HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var client = http.GetCurrentUser()!;

        var activeProgram = await db.ProgramsForClient(client.Id)
            .Where(p => p.Status == ProgramStatuses.Active)
            .Select(p => new ActiveProgramSummary(p.Id, p.Title, p.StartsOn))
            .AsNoTracking()
            .FirstOrDefaultAsync(cancellationToken);

        var response = new MeResponse(
            client.Id, client.Email, client.DisplayName, client.Timezone, client.WeightUnit,
            activeProgram);
        return Results.Ok(response);
    }

    // #99. The client's own weight unit, written from the toggle on the log screen — the one
    // place the question actually arises, since it arises while looking at a number you cannot
    // read. The trainer sets the default when adding them; this is the correction.
    //
    // There is no id in the URL, so there is nothing to tamper with: the row written is the
    // session's user, which is the structural-zero-IDOR property this whole namespace claims in
    // the header comment above. That is also why the isolation test for this route asserts that
    // another client's row is untouched rather than asserting a 404 on a foreign id — there is
    // no foreign id to ask for.
    private static async Task<IResult> UpdateMe(
        UpdateMeRequest body,
        HttpContext http,
        TrainerOsDbContext db,
        CancellationToken cancellationToken)
    {
        var current = http.GetCurrentUser()!;

        // #145: weight_unit backs a NOT NULL column, so null is a request to clear something
        // that cannot be cleared. Refused rather than read as "leave alone".
        if (PatchRequests.RejectNull(body.WeightUnit, "weight_unit") is { } unitNull)
        {
            return unitNull;
        }

        string? weightUnit = null;
        if (body.WeightUnit.HasValue(out var sentUnit))
        {
            weightUnit = WeightUnits.Normalize(sentUnit);
            if (weightUnit is null)
            {
                return Results.BadRequest(
                    ApiError.Create("bad_request", "weight_unit must be 'kg' or 'lb'."));
            }
        }

        // Re-read rather than mutating GetCurrentUser()'s instance: SessionAuthMiddleware
        // resolves the session user with AsNoTracking(), so the one on HttpContext is detached
        // and assigning to it would save nothing. UserById is the sanctioned path for exactly
        // this (AuthQueryExtensions: "identity resolution by ... the session's user id");
        // db.Set<User>() would bypass the boundary and fail review (conventions.md).
        var client = await db.UserById(current.Id).FirstOrDefaultAsync(cancellationToken);
        if (client is null)
        {
            // The session resolved a user a moment ago, so this is a row deleted mid-request.
            return Results.NotFound(ApiError.Create("not_found", "Not Found"));
        }

        if (weightUnit is not null)
        {
            client.WeightUnit = weightUnit;
            await db.SaveChangesAsync(cancellationToken);
        }

        // The full MeResponse rather than 204, matching every other write on this API: the SPA
        // folds the response into session state, so the toggle needs the canonical row back and
        // not a second GET to find out what it just wrote. An empty body would also make the
        // no-op case (weight_unit absent) indistinguishable from a write.
        var activeProgram = await db.ProgramsForClient(client.Id)
            .Where(p => p.Status == ProgramStatuses.Active)
            .Select(p => new ActiveProgramSummary(p.Id, p.Title, p.StartsOn))
            .AsNoTracking()
            .FirstOrDefaultAsync(cancellationToken);

        return Results.Ok(new MeResponse(
            client.Id, client.Email, client.DisplayName, client.Timezone, client.WeightUnit,
            activeProgram));
    }

    private static async Task<IResult> GetMyProgram(
        HttpContext http, TrainerOsDbContext db, CancellationToken cancellationToken)
    {
        var client = http.GetCurrentUser()!;

        // Two queries, not N+1: query 1 pulls the program with days and prescriptions
        // in a single tree via nested projection; query 2 fetches the referenced exercises
        // in one WHERE id IN (...). The AC's "no N+1 waterfall" rules out per-prescription
        // exercise lookups; two round-trips is the honest ceiling.
        var program = await db.ProgramsForClient(client.Id)
            .Where(p => p.Status == ProgramStatuses.Active)
            .Select(p => new
            {
                p.Id,
                p.TrainerId,
                p.Title,
                p.Status,
                p.StartsOn,
                p.Notes,
                Days = p.Days
                    .OrderBy(d => d.Position)
                    .Select(d => new
                    {
                        d.Id,
                        d.Title,
                        d.Position,
                        Prescriptions = d.Exercises
                            .OrderBy(pdx => pdx.Position)
                            .Select(pdx => new
                            {
                                pdx.Id,
                                pdx.Position,
                                pdx.TargetSets,
                                pdx.TargetReps,
                                pdx.TargetLoad,
                                pdx.RestSeconds,
                                pdx.Note,
                                pdx.ExerciseId,
                            })
                            .ToList(),
                    })
                    .ToList(),
            })
            .AsNoTracking()
            .FirstOrDefaultAsync(cancellationToken);

        if (program is null)
        {
            return Results.Ok(new MeProgramWrapper(null));
        }

        var exerciseIds = program.Days
            .SelectMany(d => d.Prescriptions)
            .Select(p => p.ExerciseId)
            .Distinct()
            .ToList();

        // Exercises scoped by the *program's* trainer_id (not the client's, in case the
        // client's row is ever out of sync) — same trainer authored the program and its
        // library, so the join is safe and the ExercisesForTrainer boundary still holds.
        var exercises = exerciseIds.Count == 0
            ? new Dictionary<Guid, ExerciseView>()
            : await db.ExercisesForTrainer(program.TrainerId)
                .Where(e => exerciseIds.Contains(e.Id))
                .Select(e => new ExerciseView(e.Id, e.Name, e.VideoUrl, e.Cues))
                .AsNoTracking()
                .ToDictionaryAsync(e => e.Id, cancellationToken);

        var details = new MeProgramDetails(
            program.Id, program.Title, program.Status, program.StartsOn, program.Notes,
            program.Days.Select(d => new DayView(
                d.Id, d.Title, d.Position,
                d.Prescriptions.Select(pdx => new PrescriptionView(
                    pdx.Id, pdx.Position, pdx.TargetSets, pdx.TargetReps,
                    pdx.TargetLoad, pdx.RestSeconds, pdx.Note,
                    exercises[pdx.ExerciseId]
                )).ToList()
            )).ToList());

        return Results.Ok(new MeProgramWrapper(details));
    }
}
