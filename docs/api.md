# TrainerOS — api.md (v1)

Status: Draft for review
Scope: REST-ish JSON API for v1. Framework/hosting choice lives in architecture.md; this doc is transport-level and framework-agnostic.
Consumers: one first-party web client. No public API, no third-party consumers.

---

## Conventions

- Base path `/api`. **No version prefix.** One first-party client deployed in lockstep with the server; `/v1` is ceremony for consumers that don't exist. If a real versioning need appears, that's the day to add it. (Rejected: `/api/v1` by default — cargo cult at this scale.)
- JSON in/out. Errors are a single shape: `{ "error": { "code": "string", "message": "human text" } }`. No stack traces, no ORM error passthrough.
- Identity comes from the session cookie, **never** from the request body or query string. There is no endpoint that accepts "act as user X."
- All timestamps UTC ISO-8601 in transport; client renders local.

## Authorization model (the point of this document)

Lesson applied from Plant Plotter IDOR: object-level authorization is not a middleware checkbox, it's a query-shape discipline.

1. **Scoped queries, not load-then-check.** Every data query includes the owner in the WHERE clause: trainer endpoints filter `trainer_id = session.user_id`; client endpoints filter `client_id = session.user_id`. There is no code path that loads a row by bare id and then decides. A scoped query that finds nothing returns 404.
   (Rejected: fetch-by-id + ownership assertion — it works until one new endpoint forgets the assertion. Scoping makes the safe path the only path.)
2. **404, not 403, for other people's objects.** A client requesting another client's session id gets the same 404 as a nonexistent id. 403 confirms the resource exists — an enumeration gift. (Rejected: 403 — leaks existence.)
3. **Nested ownership chains verified by join.** `logged_sets` belong to a session which belongs to a client: writes to `/sessions/:id/sets` join through to `client_id = session.user_id` in one query. Never trust the parent id in the URL alone.
4. **Role gates are route-level; ownership is query-level.** `requireTrainer` / `requireClient` middleware rejects the wrong role early with 404 (same non-leak rule), but ownership is still enforced in every query — middleware is a convenience, not the security boundary.
5. **Testable invariant:** for every client-facing GET/POST, an integration test authenticates as client A and requests client B's resource, asserting 404. This test suite is the executable form of "clients are isolated."

6. Resolved in #19: absent/expired/revoked session → 401; authenticated wrong-role → 404. Spec was silent; 401 for anonymous requests leaks no route information and lets the SPA distinguish login-required from not-found.

7. #24: trainer is seeded from env vars (Seed__TrainerEmail/Password), Argon2id-hashed, idempotent on any-trainer-exists, never overwritten — password rotation is deliberately absent; magic-link (#20) is the recovery path." Plus one env-var note onto issue #57's checklist: the two seed vars join the deploy configuration.

## Auth endpoints

### POST /api/auth/magic-link
Body: `{ email }`. Always returns `202 { ok: true }` whether or not the email exists — no user enumeration via response differences or timing-obvious branches.
Revised in #20: all active users (including the trainer) receive magic links — the flow doubles as v1 password recovery, since no reset flow exists. Deactivated users are silently excluded (202, nothing sent).
Rate limits (v1-sized, in-memory or single Redis-free table): 3 requests / email / 15 min, 10 / IP / hour. Prevents email-bombing a client and provider-quota burn.

### GET /api/auth/verify?token=...
**Renders/validates only — does not consume.** Returns whether the token is valid so the client app can show a "Continue to TrainerOS" button.
**Decision (same prefetch rule as the pause link):** mail scanners GET links before the user does. A GET that consumes the login token means the client taps a dead link. GET never mutates; consumption is POST-only. This is now a doc-wide invariant, stated once here: **no state change on GET, anywhere in the API.**

### POST /api/auth/verify
Body: `{ token }`. Consumes the token (single-use, 15 min expiry, hash-compared), creates a session row, sets httpOnly Secure SameSite=Lax cookie. 90-day expiry for clients, 30 for trainer.
#21: all POST rejections (invalid/expired/used/deactivated) are an indistinguishable 401 invalid_token — no validity oracle. Successful POST returns {ok:true} only; the SPA bootstraps identity via GET /api/me (#30).

### POST /api/auth/login
Trainer only. `{ email, password }` → session cookie. Argon2id hash comparison. Same 404-shaped rejection for unknown email vs wrong password ("invalid credentials", no distinction).

### POST /api/auth/logout
Revokes current session row.

## Trainer endpoints (role: trainer; all queries scoped by trainer_id)

| Method & path | Purpose | Notes |
|---|---|---|
| GET /api/clients | list clients | includes is_active |
| POST /api/clients | create client | body: email, display_name, timezone. Sends nothing; invite = trainer tells them to log in via magic link |
| PATCH /api/clients/:id | edit / deactivate | is_active=false also disables their schedules (single transaction) |
| GET /api/clients/:id/sessions | client's workout history | trainer view of logs |
| GET/POST /api/exercises, PATCH /api/exercises/:id | exercise library | delete = PATCH is_active=false (soft-delete per database.md) |
| GET/POST /api/programs | list/create (client_id in body on create) | create enforces one-active-per-client via partial unique index; 409 on conflict |
| GET/PATCH /api/programs/:id | read/edit incl. status transitions | |
| POST /api/programs/:id/days, PATCH/DELETE /api/days/:id | manage days | |
| POST /api/days/:id/exercises, PATCH/DELETE /api/day-exercises/:id | manage prescriptions | position handling: client sends full ordered id list on reorder (PATCH /api/days/:id/order), server rewrites positions in one transaction. (Rejected: fractional/gap positions — clever, unnecessary at this scale.) |
| GET/POST /api/clients/:id/schedule, PATCH /api/schedules/:id | reminder schedule | one schedule per client in v1 |

## Client endpoints (role: client; all queries scoped by session user)

| Method & path | Purpose | Notes |
|---|---|---|
| GET /api/me | identity, timezone, active program summary | the dashboard bootstrap call |
| GET /api/me/program | full active program: days → prescriptions → exercise (name, video_url, cues) | one response, no N+1 waterfall from the client |
| POST /api/me/sessions | start/record a workout session | body: performed_on, program_day_id (nullable), comment |
| POST /api/me/sessions/:id/sets | log a set | body: exercise_id, program_day_exercise_id?, set_number, weight_kg?, reps. Ownership of :id verified by join |
| PATCH /api/me/sets/:id | fix a typo'd set | same-day only (editing history weeks later is a data-integrity smell; 403-shaped 404 after that) |
| GET /api/me/history?exercise_id=&before=&limit= | past sessions / per-exercise history | powers "what did I do last time." Cursor pagination (before = logged_at), not offset |
| GET /api/me/last?exercise_id= | most recent sets for an exercise | the gym-floor query; kept separate and fast |

**Decision — `/api/me/*` namespace for client routes:** the URL never contains the client's own id, so there is nothing to tamper with. The IDOR surface for client self-service is structurally zero. (Rejected: `/api/clients/:id/...` shared with trainer routes — every route becomes an ownership check that can be forgotten.)

## Pause endpoints (unauthenticated, token-bearing — per notifications.md)

- GET /api/pause?token= → validates HMAC token, renders confirmation state
- POST /api/pause → consumes token, sets schedule enabled=false

#22: login rejections (unknown/wrong-password/client-email/deactivated) are byte-identical 401s with dummy-hash timing parity. Logout is unauthenticated-tolerant — always 200 + cookie clear — to avoid trapping users with dead cookies; revocation is server-side via revoked_at.

## Cross-cutting

- **Rate limiting:** only auth + pause endpoints in v1. Authenticated traffic from 4 users does not need throttling; adding it everywhere is ceremony.
- **Validation:** schema-validated bodies at the edge (zod or equivalent); unknown fields rejected, not ignored — silent-ignore hides client bugs.
- **CORS:** same-origin deployment planned (client served by/with the API); if split-origin later, allowlist exactly one origin, credentials mode. No wildcard, ever, with cookie auth.
- **Idempotency:** POST /sessions/:id/sets is not idempotent and doesn't need to be in v1 (double-tap creates a duplicate set the client can delete same-day). Noted as the honest gap; client-side disable-on-submit mitigates. (Contrast: notification sends, where duplication is systemic — that's why idempotency lives there.)

## Non-goals (v1)

- Public API, API keys, third-party consumers
- /v1 versioning, HATEOAS, OpenAPI generation (a hand-kept route table is enough at 25 routes)
- Websockets / realtime (no messaging in v1)
- Offset pagination, search, filtering beyond history params
- Generation via @hey-api/openapi-ts — openapi-typescript peer-conflicts with TS 6.
