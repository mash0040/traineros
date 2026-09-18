# TrainerOS — architecture.md (v1)

Status: Draft for review
This doc is deliberately short. The real decisions live in database.md, notifications.md, and api.md; this records the stack, the deployment shape, and why.

---

## Stack

| Layer | Choice | Why / rejected alternatives |
|---|---|---|
| API | ASP.NET Core 8, minimal APIs | C# chosen for AZ-204 alignment, GTA .NET market, and existing C# background. Minimal APIs over MVC controllers: 25 routes, one consumer — controller ceremony buys nothing. |
| ORM | EF Core + Npgsql | Scoped-query discipline from api.md is enforced via required query filters/extension methods (`.ForTrainer(id)`, `.ForClient(id)`), not remembered per-handler. |
| Background jobs | Azure Functions, .NET isolated worker | Scheduler = timer trigger; worker = queue trigger. Isolated worker over in-process: it's the only supported model going forward and the AZ-204-relevant one. |
| Queue | Azure Queue Storage | See notifications.md — Service Bus rejected there. |
| DB | PostgreSQL | Azure Database for PostgreSQL Flexible Server (burstable B1ms) in prod. Frugal alternative if cost bites: Neon free tier — weakens the all-Azure story, keeps the app identical. Decide at deploy time, not now. |
| Web client | React + TypeScript + Vite | Existing strength; no reason to change. Types generated from OpenAPI (see api.md reversal) — DTOs are never hand-duplicated. |
| Email | Resend | See notifications.md. INotificationSender and the Resend adapter both live in TrainerOS.Domain/Notifications (moved from Api in #38) so Api and Functions bind the same implementation; each host branches Console/Resend by environment and carries the #16 fail-fast startup guard. |
| Auth | Hand-rolled sessions + magic links per api.md | Rejected: ASP.NET Identity — its user/password/role machinery fights the magic-link model and buries the auth logic this project exists to demonstrate. Sessions table + middleware is ~200 lines and fully understood. |

## Deployment shape

**One App Service (B1) serves both the API and the built SPA** (Vite output copied to wwwroot). 

- Same-origin: cookie auth works with zero CORS surface (api.md's preferred case).
- One deploy pipeline for the product; Functions deploy separately (they change on a different cadence).
- Rejected: Azure Static Web Apps + separate API — SWA's linked-API model is Functions-only, our API isn't; split-origin adds CORS + cookie config for no benefit at this scale.
- Rejected for now: Container Apps — scale-to-zero saves ~$13/mo but adds Docker + registry to the critical path, and cold starts on the API would hit a client mid-gym-session. Noted as the v2 migration if cost matters and traffic stays tiny.

```
GitHub repo
 ├─ push to main
 │   ├─ GitHub Actions: build API + SPA → deploy App Service
 │   ├─ GitHub Actions: build Functions → deploy Function App
 │   └─ EF Core migration bundle applied as a pipeline step (not on-startup:
 │      startup migrations + multiple instances = race; bundle is the boring correct way)
 ▼
Azure: App Service (API+SPA) · Function App (scheduler, worker) · Queue Storage · Postgres Flexible · App Insights
Secrets: App Service/Functions configuration + managed identity where supported (AZ-204 content). No secrets in repo. GH_TOKEN etc. per Nelson-workflow rules.
```

**Local dev:** `dotnet watch` (API) + Vite dev server (proxy to API) + local Postgres + Azurite (queue emulation). Functions run locally via Core Tools against Azurite. Everything runs with no Azure account — the quota problem that blocked lab work cannot block this project.

**Honest cost statement:** ~$28 USD/mo (B1 + burstable PG) once live. $0 during development. If that's unacceptable, the Neon + Container Apps combo gets near-zero but trades away simplicity and the always-warm API. Recorded so future-you knows it was a choice.

**Cost-ladder decision (2026-07-11, backlog phase):** start on the free rungs — App Service **F1** + **Neon free Postgres** — and promote to B1 / Azure PG Flexible only if the free tiers bite. The ~$28/mo figure above is the promoted rung, not the starting point. Early provisioning (resource group, Storage account + queues, App Insights — Storage is pay-as-you-go from the first byte (no free tier) at roughly $0.05/mo at v1 volume; the resource group, Log Analytics workspace, and App Insights component are free to exist, with ingestion inside the 5 GB/month grant.) happens up front to surface subscription/quota errors; App Service and database are provisioned only when the deploy pipeline needs a target.

## Repo layout (merging the .claude convention with the C# solution)

```
traineros/
├── .claude/                  # rules, skills (agents/ and commands/ exist but are empty)
├── docs/                     # CONTEXT.md, architecture.md, database.md, api.md, notifications.md, ui-ux.md, deploy-config.md
├── planning/                 # CONTEXT.md, backlog notes
├── src/
│   ├── TrainerOS.Api/        # ASP.NET Core minimal API (+ serves SPA from wwwroot in prod)
│   ├── TrainerOS.Functions/  # scheduler + worker (isolated)
│   ├── TrainerOS.Domain/     # entities, EF Core model, scoped-query extensions — shared by Api & Functions
│   └── web/                  # React/Vite client (TS types generated from OpenAPI)
├── tests/
│   └── TrainerOS.Tests/      # incl. the client-isolation 404 suite (api.md §5)
├── TrainerOS.sln
├── CLAUDE.md                 # agent entry point → points at docs/
├── PRODUCT.md                # scope, non-goals, DEFINITION OF SHIPPED (below)
├── DESIGN.md                 # visual system for src/web (tokens, typography, layout)
└── README.md
```

**Decision:** `TrainerOS.Domain` is shared by Api and Functions so the worker renders email content from the same entities and scoped-query rules — no duplicated data access, and the isolation discipline applies to background code too (a worker that queries unscoped is the same IDOR with no URL).

## Definition of shipped (the forcing function)

v1 is DONE when: **one real client has logged one real workout through the deployed app, and has received one real reminder email that a duplicate scheduler run did not duplicate.**

Everything not required for that sentence is v1.1 or later. This line exists because the failure mode of this project is not bad architecture — it's unfinished architecture.

## Non-goals (v1)

- Docker/Kubernetes/Container Apps, IaC (Bicep/Terraform) — clickops + documented config is honest at one environment. IaC is a fine v2 learning goal, after shipped.
- Multi-environment (staging) — main deploys to prod; 4 users, feature-flag-free
- Redis/caching layer — Postgres serves 4 users without help; caching would be resume theater
- Microservices — this is a modular monolith + two functions, on purpose; the seams (Domain project, INotificationSender, queue) are where it would split IF it ever needed to
