# TrainerOS — database.md (v1)

Status: Draft for review
Scope: v1 only — single trainer, existing clients, mobile-first web app.
Database: PostgreSQL (Azure Database for PostgreSQL when deployed; local Postgres in dev). Swappable, but all decisions below assume relational + SQL.

This document records not just the schema but the decisions behind it and the alternatives rejected. It is the system-design artifact for the data layer.

---

## Design principles

1. **Tenant-aware, not multi-tenant.** Every domain table carries `trainer_id` even though v1 has exactly one trainer. No trainer onboarding, no org model — but the schema never needs a migration to support a second trainer. (Rejected: full multi-tenant features in v1 — pure speculation at 3 clients. Rejected: omitting `trainer_id` — turns a future feature into a rewrite.)
2. **Client isolation is the security invariant.** A client must never read another client's data. Enforced in the application layer: every query for client-facing endpoints is scoped by the authenticated `user_id`. (Rejected for v1: Postgres Row-Level Security — correct at scale, but adds operational complexity before there's a second trainer. Documented as the v2 upgrade path.). 
(Enforced structurally in #18: owned-entity DbSets are internal; the scoped-query extensions on TrainerOsDbContext are the only compiling access path from Api/Functions, with a reflection tripwire test pinning the surface.)
3. **Personalization is data, not UI.** One dashboard component; per-client rows. No per-client layouts or config tables.
4. **Logs are ground truth.** What the client actually did is never overwritten by program edits. Logged sets stand alone and remain valid even if the program that prescribed them is edited or deleted.

---

## Entity overview

```
users ──< sessions
users (trainer) ──< clients (users) ... via trainer_id
users ──< magic_link_tokens

exercises (trainer's library)
programs (belongs to ONE client) ──< program_days ──< program_day_exercises >── exercises
workout_sessions (client's gym visit) ──< logged_sets >── exercises
                                                      └── program_day_exercises (nullable)

notification_schedules ──< notification_deliveries
```

---

## Tables

### users
One table for both roles. v1 has 1 trainer + N clients.

| column        | type        | notes                                   |
|---------------|-------------|-----------------------------------------|
| id            | uuid PK     |                                         |
| role          | text        | 'trainer' \| 'client'                   |
| email         | citext UNIQUE | login identity + reminder channel     |
| display_name  | text        |                                         |
| trainer_id    | uuid FK → users | NULL for the trainer; set for clients |
| timezone      | text        | IANA tz, e.g. 'America/Toronto'. Needed for reminder scheduling. |
| password_hash | text NULL   | Set only for trainer. Clients have none. |
| is_active     | boolean     | Soft-deactivate clients who stop training. |
| created_at    | timestamptz |                                         |

**Decision:** single `users` table with a role column, not separate `trainers`/`clients` tables. One auth path, one sessions table. (Rejected: separate tables — duplicates auth machinery for zero v1 benefit.)

**Decision:** timezone lives on the user, captured at first login (browser tz) and editable. Reminders are meaningless without it.

### magic_link_tokens
| column     | type        | notes                                        |
|------------|-------------|-----------------------------------------------|
| id         | uuid PK     |                                               |
| user_id    | uuid FK     |                                               |
| token_hash | text        | SHA-256 of the token. Raw token only in the email. |
| expires_at | timestamptz | 15 minutes                                    |
| used_at    | timestamptz NULL | single-use                              |

**Decision:** store the hash, never the token — a DB leak must not yield working login links.

### sessions
| column     | type        | notes                          |
|------------|-------------|--------------------------------|
| id         | uuid PK     | opaque session id in an httpOnly, Secure cookie |
| user_id    | uuid FK     |                                |
| expires_at | timestamptz | 90 days for clients, 30 for trainer |
| created_at | timestamptz |                                |
| revoked_at | timestamptz NULL |                           |

**Decision:** server-side sessions, not JWTs. Revocable (lost phone, deactivated client), trivially simple, and no token-refresh choreography. Statelessness solves a scaling problem v1 does not have. (Rejected: JWT access/refresh pattern — complexity without payoff at this scale; revocation story is worse.)

### exercises
Trainer's exercise library, shared across all clients.

| column     | type    | notes                                        |
|------------|---------|-----------------------------------------------|
| id         | uuid PK |                                               |
| trainer_id | uuid FK |                                               |
| name       | text    |                                               |
| video_url  | text NULL | YouTube link (unlisted or public). No self-hosted video in v1. |
| cues       | text NULL | coaching notes shown to client              |
| created_at | timestamptz |                                          |
| is_active  | boolean | soft-delete per resolved question 1 |

**Decision:** `video_url` is a text column pointing at YouTube. (Rejected: upload + object storage + player — an entire subsystem for identical client value. Non-goal until there's a concrete reason.)

### programs
A program belongs directly to one client. There is no template/assignment layer in v1.

| column     | type    | notes                                    |
|------------|---------|-------------------------------------------|
| id         | uuid PK |                                           |
| trainer_id | uuid FK |                                           |
| client_id  | uuid FK → users |                                   |
| title      | text    | e.g. 'Hypertrophy Block — Feb'            |
| status     | text    | 'draft' \| 'active' \| 'archived'         |
| starts_on  | date NULL |                                         |
| notes      | text NULL |                                         |
| created_at / updated_at | timestamptz |                       |

**Decision:** client-owned programs, no templates. Every program is personalized anyway; templates + immutable snapshots were machinery for a reuse problem that doesn't exist at 3 clients. Reuse later = "duplicate program to another client," a feature, not a schema change. This also removes the program-versioning problem from v1 entirely.

**Rule:** at most one `active` program per client (partial unique index on `(client_id) WHERE status = 'active'`).

### program_days
| column     | type    | notes                          |
|------------|---------|--------------------------------|
| id         | uuid PK |                                |
| program_id | uuid FK | ON DELETE CASCADE              |
| title      | text    | 'Day A — Lower', 'Push', etc.  |
| position   | int     | ordering within the program    |

### program_day_exercises
The prescription row.

| column         | type    | notes                                  |
|----------------|---------|-----------------------------------------|
| id             | uuid PK |                                         |
| program_day_id | uuid FK | ON DELETE CASCADE                       |
| exercise_id    | uuid FK → exercises |                             |
| position       | int     | ordering within the day                 |
| target_sets    | int     |                                         |
| target_reps    | text    | text, not int: '8–10', 'AMRAP', '5/3/1' are all real prescriptions |
| target_load    | text NULL | '100 kg', 'RPE 8', '70%' — free text on purpose |
| rest_seconds   | int NULL |                                        |
| note           | text NULL | per-exercise instruction              |

**Decision:** `target_reps` and `target_load` are text. Coaching prescriptions are not integers ('8–12', 'RPE 7–8', 'top set + backoffs'). Structured numeric targets would either straitjacket real programming or require a mini-DSL. Parsing for analytics is a v2 problem; v1 displays them verbatim.

### workout_sessions
One row per gym visit.

| column         | type    | notes                                      |
|----------------|---------|---------------------------------------------|
| id             | uuid PK |                                             |
| trainer_id     | uuid FK | denormalized for tenancy scoping            |
| client_id      | uuid FK |                                             |
| program_day_id | uuid FK NULL | which day they intended to do; NULL = freestyle session |
| performed_on   | date    |                                             |
| comment        | text NULL | client's note to trainer ('shoulder tweaked on OHP'). This is the v1 substitute for messaging. |
| created_at     | timestamptz |                                        |

### logged_sets
Ground truth of what happened.

| column                  | type    | notes                                 |
|-------------------------|---------|----------------------------------------|
| id                      | uuid PK |                                        |
| session_id              | uuid FK | ON DELETE CASCADE                      |
| exercise_id             | uuid FK → exercises | ALWAYS set               |
| program_day_exercise_id | uuid FK NULL | set when performing prescribed work; NULL for extra/substituted work |
| set_number              | int     |                                        |
| weight_kg               | numeric NULL | NULL for bodyweight               |
| reps                    | int     |                                        |
| logged_at               | timestamptz |                                    |

**Decision:** dual reference. `exercise_id` always (history queries stay one join: "all my squat sets, ever"), `program_day_exercise_id` when applicable (enables target-vs-actual display without breaking on improvised work). (Rejected: prescription-only reference — breaks the moment a client substitutes because the rack is taken. Rejected: exercise-only — loses target-vs-actual for free.)

Delete behavior: workout_sessions.program_day_id and logged_sets.program_day_exercise_id are ON DELETE SET NULL — logged history survives program editing (principle 4). All other non-specced FKs are explicit RESTRICT so EF conventions can't introduce cascades.

**Note:** history/"what did I do last time" and future progress charts are all reads over this table. No separate analytics tables in v1.

### notification_schedules
What should be sent, and when.

| column      | type    | notes                                       |
|-------------|---------|----------------------------------------------|
| id          | uuid PK |                                              |
| trainer_id  | uuid FK |                                              |
| client_id   | uuid FK |                                              |
| kind        | text    | v1: 'workout_reminder'                       |
| send_time   | time    | local time of day, e.g. 07:00                |
| days_of_week| int[]   | e.g. {1,3,5}                                 |
| enabled     | boolean |                                              |

Timezone comes from `users.timezone` at send-computation time, so a client who moves doesn't strand their schedule.

### notification_deliveries
One row per send attempt-group. This is the audit trail and the idempotency mechanism.

| column          | type    | notes                                       |
|-----------------|---------|----------------------------------------------|
| id              | uuid PK |                                              |
| schedule_id     | uuid FK |                                              |
| user_id         | uuid FK | recipient                                    |
| channel         | text    | v1: 'email'. Column exists so WhatsApp/push are adapters later, not migrations. |
| scheduled_for   | timestamptz | the UTC instant this occurrence targets  |
| idempotency_key | text UNIQUE | `{schedule_id}:{local occurrence date}` — local, not UTC (see notifications.md #36); the scheduler can run twice without double-sending |
| status          | text    | 'pending' \| 'sent' \| 'failed' \| 'dead'    |
| attempts        | int     | retry counter                                |
| last_error      | text NULL |                                            |
| sent_at         | timestamptz NULL |                                     |

**Decision:** idempotency enforced by a unique key in the database, not by scheduler discipline. The enqueue step is INSERT ... ON CONFLICT DO NOTHING; duplicate scheduler runs become no-ops. Retry policy, backoff, and dead-lettering behavior are specified in notifications.md; this table is their persistence.

---

## Indexing (v1 minimum)

- `logged_sets (exercise_id, logged_at)` — powers "last time you did X" and history.
- `workout_sessions (client_id, performed_on DESC)` — client history screen.
- `sessions (user_id)`, `magic_link_tokens (token_hash)`.
- `notification_deliveries (status, scheduled_for)` — worker's poll query.
- Partial unique: `programs (client_id) WHERE status = 'active'`.

## Explicit non-goals (v1)

- Program templates, versioning, or snapshots
- Self-hosted video / uploads
- In-app messaging (WhatsApp + session comment field cover it)
- Charts tables or materialized analytics (derive from logged_sets later)
- Postgres RLS (app-layer scoping now; RLS is the multi-trainer upgrade)
- Offline sync (online-only logging in v1)

## Resolved questions

1. **Exercise deletion: soft-delete (`is_active`).** logged_sets reference exercises; hard delete would orphan ground truth. (Also stated in PRODUCT.md and api.md.)
2. **Trainer logs their own workouts as a client of themselves — yes.** The trainer user gets programs via self-referencing `trainer_id`. Zero schema change; migration 001 must not add a constraint preventing `trainer_id = id`.

## Naming

Naming: tables and columns are snake_case as written in this doc, enforced by explicit EF Core configuration (not conventions)
