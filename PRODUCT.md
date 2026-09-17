## Users

Two audiences with different needs and different devices.

**Trainers** are independent personal trainers writing programs for clients they coach remotely or sell programs to. They currently work out of WhatsApp, Google Sheets, and a notes app. They use TrainerOS on a phone in a gym between sessions, not at a desk.

**Clients** are people following a program their trainer wrote. They open the app mid-workout, one-handed, with elevated heart rate and about sixty seconds of attention. Most have never used a training app; the thing they're switching from is a paper notebook or nothing.

## Product Purpose

TrainerOS replaces the gap between a trainer sending a program and finding out whether anyone followed it. Trainers build per-client programs in real coaching language; clients log each set beside what they lifted at that position last session.

Success is measured two ways: a client logs a workout in the app rather than in a notebook or not at all, and a trainer can see what a client actually lifted without asking them.

The product competes with a paper notebook, not with other apps. The inline last-time number is the feature that wins that comparison: everything else is in service of it.

# TrainerOS — PRODUCT.md

Aggregated from docs/architecture.md, docs/database.md, docs/api.md, docs/notifications.md, docs/ui-ux.md. Those documents are the source of truth for design detail; this file is the scope boundary.

---

## v1 scope

- **One trainer, existing clients (~3), mobile-first web app.** Tenant-aware schema (`trainer_id` everywhere) but no trainer onboarding or org model.
- **Auth:** magic-link login for clients; email + password (Argon2id) for the trainer. Server-side sessions in an httpOnly cookie — no JWTs, no ASP.NET Identity.
- **Client isolation as the security invariant:** every query scoped by the authenticated user (`.ForTrainer()` / `.ForClient()`); 404 (never 403) for other people's objects; no state change on GET, anywhere in the API.
- **Exercise library** (trainer-owned): name, YouTube video URL, cues; soft-delete.
- **Programs:** client-owned (no templates/versioning), days → prescriptions (text targets: '8–10', 'RPE 8'), at most one active program per client, reorder via full-list rewrite.
- **Workout logging:** sessions (with client comment as the messaging stand-in) + logged sets with dual exercise/prescription reference; same-day set edits only; history and "last time" queries with cursor pagination.
- **Workout reminder emails:** timer-triggered scheduler + Azure Queue Storage + queue-triggered worker; DB-enforced idempotency (`ON CONFLICT DO NOTHING`); at-least-once delivery, queue-native retry/backoff, poison handling, staleness expiry; wall-clock local send times from `users.timezone`; two-step (GET renders, POST mutates) pause link; Resend behind an `INotificationSender` adapter.
- **Nine screens** — client: Login, Today, Log workout, History, Pause reminders; trainer: Clients, Client detail, Program builder, Exercise library. Tailwind, no component library. Gym-floor constraints bind the logging screen.
- **API:** `/api` base path (no version prefix), JSON, single error shape, `/api/me/*` namespace for client routes, rate limiting on auth + pause endpoints only, schema-validated bodies rejecting unknown fields.
- **Deployment:** one App Service (B1) serving API + built SPA same-origin; Functions deploy separately; EF Core migration bundle as a pipeline step; GitHub Actions from main; App Insights. Local dev fully offline from Azure (local Postgres + Azurite).

## Definition of Shipped (verbatim from architecture.md)

v1 is DONE when: **one real client has logged one real workout through the deployed app, and has received one real reminder email that a duplicate scheduler run did not duplicate.**

Everything not required for that sentence is v1.1 or later. This line exists because the failure mode of this project is not bad architecture — it's unfinished architecture.

## Non-goals (v1) — aggregated

### From architecture.md
- Docker/Kubernetes/Container Apps, IaC (Bicep/Terraform) — clickops + documented config is honest at one environment. IaC is a fine v2 learning goal, after shipped.
- Multi-environment (staging) — main deploys to prod; 4 users, feature-flag-free
- Redis/caching layer — Postgres serves 4 users without help; caching would be resume theater
- Microservices — this is a modular monolith + two functions, on purpose; the seams (Domain project, INotificationSender, queue) are where it would split IF it ever needed to

### From database.md
- Program templates, versioning, or snapshots
- Self-hosted video / uploads
- In-app messaging (WhatsApp + session comment field cover it)
- Charts tables or materialized analytics (derive from logged_sets later)
- Postgres RLS (app-layer scoping now; RLS is the multi-trainer upgrade)
- Offline sync (online-only logging in v1)

### From api.md
- Public API, API keys, third-party consumers
- /v1 versioning, HATEOAS, OpenAPI generation (a hand-kept route table is enough at 25 routes)
- Websockets / realtime (no messaging in v1)
- Offset pagination, search, filtering beyond history params

### From notifications.md
- WhatsApp / SMS / web push (adapter slot exists; not built)
- Notification preferences UI beyond enable/disable + time
- Digest/batching, quiet hours, per-exercise nudges
- Exactly-once delivery (documented tradeoff instead)
- Metrics dashboards

### From ui-ux.md
- Progress charts (v1.1 — data model already supports; see database.md)
- PWA install banner / service worker (revisit only if clients ask for "an app icon"; the share-sheet "Add to Home Screen" works today)
- Offline anything
- Trainer mobile optimization beyond "usable"
- Accessibility audit beyond semantic HTML + label/contrast basics (do the basics; skip the formal pass)
