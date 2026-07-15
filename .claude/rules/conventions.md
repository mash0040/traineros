# TrainerOS conventions

- **C# style:** the root `.editorconfig` is authoritative. Don't argue with it in review; change it or follow it.
- **API endpoints:** one endpoint file per resource under `src/TrainerOS.Api/Endpoints/` (e.g. `ClientEndpoints.cs`, `ProgramEndpoints.cs`).
- **Data access:** only through the Domain scoped-query extensions — `.ForTrainer(id)` / `.ForClient(id)` — per api.md's authorization model. No handler or Function loads a row by bare id and then checks ownership; a scoped query that finds nothing returns 404.
- **Azure Functions naming:** `{Noun}{Role}` — e.g. `ReminderScheduler`, `ReminderWorker`.
- **Migrations:** `NNN_PascalDescription` (e.g. `001_InitialSchema`).
- **Branches:** `feat/{issue}-slug` (e.g. `feat/12-magic-link-auth`).
- **Isolation tests:** for every client-facing route, an integration test that authenticates as client A and requests client B's resource, asserting 404, is mandatory — per api.md §5. A client route without its isolation test is not done.
- - Agent never commits, pushes, or opens PRs. Implement on the working tree,
  report changes, stop. The human owns all git operations.
