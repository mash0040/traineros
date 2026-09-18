# TrainerOS conventions

## Code

- **C# style:** the root `.editorconfig` is authoritative. Don't argue with it in review; change it or follow it.
- **API endpoints:** one endpoint file per resource under `src/TrainerOS.Api/Endpoints/` (e.g. `ClientEndpoints.cs`, `ProgramEndpoints.cs`).
- **Data access:** ONLY via the scoped-query extensions on `TrainerOsDbContext` (`{Entity}ForTrainer(id)` / `{Entity}ForClient(id)`); auth identity resolution via `AuthQueryExtensions` (`UserById`/`UserByEmail`). Owned-entity DbSets are internal — do not widen the context's public surface (a tripwire test enforces this). `db.Set<T>()` bypasses the boundary: any occurrence of `Set<` in Api or Functions fails review.
- **Azure Functions naming:** `{Noun}{Role}` — e.g. `ReminderScheduler`, `ReminderWorker`.
- **Migrations:** `NNN_PascalDescription` (e.g. `001_InitialSchema`).
- **Isolation tests:** for every client-facing route, an integration test that authenticates as client A and requests client B's resource, asserting 404, is mandatory — per api.md §Authorization model, rule 5. A client route without its isolation test is not done.

## Issue workflow

- GitHub Issues are the source of truth for planned work. Read the whole issue — description, comments, acceptance criteria — before proposing anything. Cross-ticket decisions are often recorded in comments rather than the body.
- Inspect the repository and the affected code, then present a plan: the proposed change, the decisions inside it, and how it will be validated. Wait for explicit approval before editing files. Skip this only when told to proceed directly.
- Once a plan is approved, work within it without asking again.
- Keep changes within the issue's scope. Report unrelated findings separately rather than folding them in.
- If the issue is stale or conflicts with the repository as it stands, say so and resolve it before implementing against a premise that may no longer hold. A ticket's stated cause is a claim to verify, not a given.
- Approval to implement never authorizes committing, pushing, or opening a PR.

## Branches

- **Naming:** `feat/{issue}-slug` (e.g. `feat/12-magic-link-auth`).
- Confirm the current branch and inspect `git status` before editing anything. Report what you find rather than inferring it — file-level reports have been reliable in this repo, git-state impressions have not.
- Never implement issue work on `main`. Documentation write-backs after a merge are the exception.
- Start a new issue branch from an up-to-date `main`. Reuse an existing branch for the same issue rather than creating a duplicate.
- Preserve unrelated changes. Never discard, overwrite, or stash them to switch branches — explain the conflict instead.
- The agent never commits, pushes, or opens PRs. Implement on the working tree, report changes, stop. The human owns all git operations.

## Validation

- Run both suites for anything touching application code: `dotnet test` and `npm test --prefix src/web`. Also `npx tsc -b` and `npx oxlint` in `src/web` for client changes.
- After any endpoint or DTO change, run `npm run generate:types` from `src/web` and confirm the diff is only what you changed. Generated types are never hand-edited.
- Verify a test can fail before trusting that it passes. Break the mechanism it covers, confirm the test goes red, revert. A test that survives deleting its own feature is covering nothing, and this repo has found several.
- Documentation-only changes need the paths and commands checked, not a build.
- State which checks were actually run, and distinguish passed, failed, skipped, and not attempted.

## SPA verification

- Vitest + React Testing Library is the default and should cover component behaviour, error paths, and security-shaped invariants. Do not drive a browser to verify what a component test can assert.
- Playwright is for discovery only — a single end-to-end pass per screen where real cookies, redirects, or network behaviour matter.
- A finding with a behavioural proxy must be pinned as a Vitest test so it never needs a browser run again. Purely visual findings (spacing, text decoration, alignment) have no such proxy: jsdom loads no stylesheet, so the only way to assert them is to assert which element carries which class, which tests implementation and breaks on any equivalent refactor. Those are the human's to catch, which is why the human drives layout passes.
- Do not take screenshots for the human; the human drives the browser for layout, feel, and gym-floor usability.

## Shell

- Commands in reports and documentation target PowerShell on Windows, not bash. Use `$VAR = "value"` for assignment, no backslash line continuations, and put command substitution on its own line rather than inline.

## Handoff

After implementation, report:

1. What changed and how it addresses the issue.
2. Checks run and their results, with mutation verification for anything security- or correctness-shaped.
3. A manual checklist for the human, specific to this change — actions and expected results, at 390px and desktop where layout is affected. Provide it even though you cannot run a browser yourself; do not substitute a statement that manual verification is unavailable. For changes with no visual impact, say manual UI testing does not apply and why.
4. Remaining concerns, unmet acceptance criteria, or follow-up work, distinguishing pre-existing defects from ones this change introduced.
5. Any spec document the change contradicts. A write-back is part of shipping, not optional.

Keep the handoff concise.

## Documentation

- README.md covers what a reader needs to understand the product, run it, and find the specs. Completing an issue does not require a README update.
- Prefer editing an existing section over adding one. Remove what a change made untrue rather than layering a correction on top.
- Detailed decisions belong in the spec documents under `docs/`, not in the README.
- Task reports, validation results, and issue-specific checklists belong in the handoff, never in committed documentation.