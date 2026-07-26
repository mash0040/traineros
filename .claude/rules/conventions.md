# TrainerOS conventions

- **C# style:** the root `.editorconfig` is authoritative. Don't argue with it in review; change it or follow it.
- **API endpoints:** one endpoint file per resource under `src/TrainerOS.Api/Endpoints/` (e.g. `ClientEndpoints.cs`, `ProgramEndpoints.cs`).
- **Data access:** ONLY via the scoped-query extensions on TrainerOsDbContext
  ({Entity}ForTrainer(id) / {Entity}ForClient(id)); auth identity resolution via
  AuthQueryExtensions (UserById/UserByEmail). Owned-entity DbSets are internal —
  do not widen the context's public surface (tripwire test enforces).
  db.Set<T>() bypasses the boundary: any occurrence of "Set<" in Api or
  Functions fails review.
- **Azure Functions naming:** `{Noun}{Role}` — e.g. `ReminderScheduler`, `ReminderWorker`.
- **Migrations:** `NNN_PascalDescription` (e.g. `001_InitialSchema`).
- **Branches:** `feat/{issue}-slug` (e.g. `feat/12-magic-link-auth`).
- **Isolation tests:** for every client-facing route, an integration test that authenticates as client A and requests client B's resource, asserting 404, is mandatory — per api.md §5. A client route without its isolation test is not done.
- - Agent never commits, pushes, or opens PRs. Implement on the working tree,
  report changes, stop. The human owns all git operations.

  - SPA verification: Vitest + React Testing Library is the default and should
  cover component behaviour, error paths, and security-shaped invariants.
  Do not drive a browser to verify what a component test can assert.
  Playwright is for discovery only — a single end-to-end pass per screen where
  real cookies, redirects, or network behaviour matter. Anything it finds must
  be pinned as a Vitest test so it never needs a browser run again.
  Do not take screenshots for the human; the human drives the browser for
  layout, feel, and gym-floor usability.
