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
        ActiveProgramSummary? ActiveProgram);

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
            client.Id, client.Email, client.DisplayName, client.Timezone, activeProgram);
        return Results.Ok(response);
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
