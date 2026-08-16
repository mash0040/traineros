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
(Clarified in #27: identity leaks via **body fields** (e.g. clientId on POST /programs) return 400 unknown_client — cross-tenant and truly-unknown collapse to the same response. Identity leaks via **route parameters** continue to return 404. Both preserve the no-existence-oracle invariant; the shape difference reflects HTTP semantics — 400 says "your input is invalid," 404 says "this URL points nowhere.")
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
| POST /api/clients | create client | body: email, display_name, timezone, weight_unit? ('kg'\|'lb', default 'lb'). Sends nothing; invite = trainer tells them to log in via magic link |
| PATCH /api/clients/:id | edit / deactivate | body: display_name?, timezone?, is_active?, weight_unit?. is_active=false also disables their schedules (single transaction) |
| GET /api/clients/:id/sessions | client's sessions (date, program day, comment) | no sets; powers the roster's last-session date |
| GET /api/clients/:id/history?before=&limit= | client's logged sets, for their trainer | same shape as GET /api/me/history — flat sets, cursor pagination. Scoped through ClientsForTrainer *and* LoggedSetsForTrainer |
| GET/POST /api/exercises, PATCH /api/exercises/:id | exercise library | delete = PATCH is_active=false (soft-delete per database.md) |
| GET/POST /api/programs | list/create (client_id in body on create) | create enforces one-active-per-client via partial unique index; 409 on conflict |
(Recorded in #27: program status transitions are unrestricted — any of {draft, active, archived} → any other. Deliberate for v1 given single-trainer scale; the 409 active-conflict constraint is the only structural gate. Restrictive transitions become worthwhile if program history needs to be auditable — v2 concern.)
| GET/PATCH /api/programs/:id | read/edit incl. status transitions | |read (returns the full tree: days → prescriptions → exercise, ordered by position) / edit incl. status transitions
| DELETE /api/programs/:id | delete a program never trained against | 204. 409 `program_has_history` if any session references its days or any logged set references its prescriptions. Archive stays the path for anything trained |
| POST /api/programs/:id/days, PATCH/DELETE /api/days/:id | manage days | |
| POST /api/days/:id/exercises, PATCH/DELETE /api/day-exercises/:id | manage prescriptions | position handling: client sends full ordered id list on reorder (PATCH /api/days/:id/order), server rewrites positions in one transaction. (Rejected: fractional/gap positions — clever, unnecessary at this scale.) |
| GET/POST /api/clients/:id/schedule, PATCH /api/schedules/:id | reminder schedule | one schedule per client in v1 |

(Recorded in #142: the trainer's view of a client's logged sets is its **own route** rather than sets nested into GET /api/clients/:id/sessions, because that route has a second consumer — the roster reads it once per client for the last-session date, and it already downloads every session a client has ever logged to render one. Nesting sets would multiply that by every set, for every client on the roster. /sessions is unchanged and keeps the roster as its one caller.

The page is **flat sets, not sessions with nested sets**, matching GET /api/me/history exactly — same records, in HistoryViews.cs, so the SPA gets one generated type and one grouping function. Grouping lives in the SPA (lib/history.ts) because that is where the hard part already is: pagination counts sets while the screen renders sessions, so a page can end mid-workout and a session must be withheld until complete rather than shown with a wrong set count. A nested response would have been a third representation of the same rows and would have had to re-answer that.

Weights are canonical kilograms and this endpoint converts nothing. The reader's unit is the **client's** `weight_unit`, on the trainer's screen as much as the client's — there is no trainer-side preference and database.md §users records why. ClientDetailScreen already holds it: the client comes from the roster read, and ClientResponse has carried `weight_unit` since #99.)

(Recorded in #118: DELETE /api/programs/:id **refuses** a program with logged history rather than relying on the SET NULL that would let it through. The database would take the delete: `workout_sessions.program_day_id` and `logged_sets.program_day_exercise_id` are both ON DELETE SET NULL, so every logged row would survive it. That behaviour exists for a narrower case than it appears to — database.md principle 4 needed a session to survive its program being *edited*, which is what DELETE /api/days/:id is, and there the builder can honestly promise a trainer that their client's history stays put. The same promise is false of a whole program: afterwards there is nothing left for the history to have pointed at. Nothing is gained by allowing it either, and that is what settles it — `archived` is already the disposal path for a trained program and it keeps every reference intact, so refusing costs the trainer no capability, only one wrong route to the same place. The endpoint exists for the other case: a program built by mistake, never trained against, with no way out of the client's list before now.

**Both foreign keys are checked, not just sessions.** The AC named only `workout_session`, and the two can disagree: POST /api/me/sessions/:id/sets validates `program_day_exercise_id` against the client's *whole library* of programs rather than against the session's own day, so a set may name this program's prescription while its session names a day in another program or no day at all. The log screen never does that today; the API is what decides what is reachable, not the screen that happens to keep the two in step.

One code, two sentences: the 409 says whether the block is workouts logged against the program's days or sets logged against its exercises, and points at archive either way. The SPA deliberately does **not** remap `program_has_history` — a copy-map entry keys on the code and would replace both sentences with one vaguer line, which is the opposite of what that map is for (see lib/apiMessages.ts).)

(Recorded in #114: MailAddress.TryCreate alone is not address validation — it parses RFC 5322 mailbox syntax, so "Ada <ada@example.com>" and "ada example@example.com" both pass, and the endpoint stored raw input rather than the parsed address. Validation now round-trips: the parsed address must equal the input byte-for-byte with no display name. Client email is write-once in v1 — PATCH /api/clients/:id has no email field, so a typo requires deactivate-and-re-add.)

(Recorded in #29: schedules can be created and edited for deactivated clients. Sending is guarded at worker time per notifications.md, so schedule state and client activation state are independent concerns; deactivation still flips enabled=false in-transaction per #25. The soft/cycling model of client activation justifies keeping them separable. TimeOnly on the wire serializes as HH:mm:ss per framework default — see issue #79 for the HH:mm converter follow-up. One schedule per client is app-enforced (no partial unique index); race window is effectively zero at v1 scale, tracked as post-v1 hardening.)

(Recorded in #78: GET /api/programs/:id returns ProgramDetailResponse — the program node plus its nested tree — while list/create/patch continue to return the flat ProgramResponse. A `days` field on the shared shape would make "not loaded" and "no days" indistinguishable. The tree records (DayView, PrescriptionView, ExerciseView) are shared with GET /api/me/program; only the program node differs, since the trainer view carries clientId and timestamps the client has no use for.)

## Client endpoints (role: client; all queries scoped by session user)

| Method & path | Purpose | Notes |
|---|---|---|
| GET /api/me | identity, timezone, weight_unit, active program summary | the dashboard bootstrap call |
| PATCH /api/me | the client's own weight_unit | body: weight_unit ('kg'\|'lb'). Returns the full MeResponse. **One field on purpose** — see below |
| GET /api/me/program | full active program: days → prescriptions → exercise (name, video_url, cues) | one response, no N+1 waterfall from the client |
(Recorded in #99: PATCH /api/me accepts `weight_unit` and nothing else, and the exclusions are the point. **email** is the login identity *and* the reminder channel, so a client editing it would silently redirect their own magic links with no recovery path — the new address is where the recovery link would go. **timezone** exists to schedule reminders, which is the trainer's job per notifications.md. **display_name** is trainer-owned; it is how the roster reads. **is_active** must never be self-service in either direction. Widening this route later should be a decision someone makes, not one they inherit.

The exclusions are enforced twice, which is worth recording because only one of them is obvious: `UpdateMeRequest` has no such member, *and* ApiConventions sets `JsonUnmappedMemberHandling.Disallow`, so `{"weightUnit":"kg","email":"..."}` is a 400 for the whole body rather than a silent drop of the field that does not belong. A client cannot move their own login identity even by accident, and the refusal is visible rather than quiet.

There is no id in the URL, so the row written is the session's user and the IDOR surface is structurally zero — the property this whole namespace is built on. That is also why its isolation test asserts another client's row is *untouched* rather than asserting a 404 on a foreign id: there is no foreign id to ask for. Bad values are 400 bad_request; the value is trimmed and lowercased first, a deliberate departure from timezone's exact match, because "LB" is unambiguous and refusing it would be pedantry rather than safety.)

(Recorded in #30: both /api/me and /api/me/program express "no active program" as an explicit null in the response shape (activeProgram: null on /api/me, program: null on /api/me/program) — 200 with null, not 404. 404 is reserved for genuine not-found; empty-state is not an error. Consistency reduces per-endpoint SPA branching.)
| POST /api/me/sessions | start/record a workout session | body: performed_on, program_day_id (nullable), comment. Resumes the existing row for (client, performed_on, program_day_id) — 200 rather than 201 — instead of creating a second |
| POST /api/me/sessions/:id/sets | log a set | body: exercise_id, program_day_exercise_id?, set_number, weight_kg?, reps. Ownership of :id verified by join |
| PATCH /api/me/sessions/:id | edit the session comment | body: comment. Same-day only, same shape as the set patch. Ownership of :id verified by join |
| PATCH /api/me/sets/:id | fix a typo'd set | same-day only (editing history weeks later is a data-integrity smell; 403-shaped 404 after that) |
| DELETE /api/me/sets/:id | remove a set logged by mistake | 204. Same ownership and same-day window as the patch. Renumbers the remaining sets for that exercise so numbering stays 1..n |

(Recorded in #32: same-day edit window is measured against `logged_sets.logged_at` converted to the client's timezone from `users.timezone`, not against `session.performed_on`. Rationale: the "typo fix" AC targets the entry event, so a workout logged retroactively remains editable through the day of entry. Consequence: two sets from the same workout can have different edit windows if entry crossed local midnight — accepted at v1 scale. Rejection past the window returns 404 shape identical to non-existent set, preserving the no-existence-oracle rule for temporal conditions.)

(Recorded in #107: the window rejection on both /api/me/sets routes is a 404 whose message is the bare HTTP reason phrase, and until now the log screen rendered it verbatim — a client who removed a set after midnight was shown **"Not Found"** mid-workout, live since #105. The 404 shape is correct and stays: it is what stops the timing rule from being probed. What was wrong is that the SPA treated it like every other refusal. The screen is the layer that can do better, on the same argument lib/apiMessages.ts makes for the trainer screens: the server answers about an id, while the row in question was on screen a second ago and came out of this session's own history. It now says the set can only be edited on the day it was logged, which is true of the other cause too (removed on another device), so it names the rule rather than guessing which happened. Scoped to the two row actions — a 404 elsewhere on that screen means something else.

Also recorded: `weight_kg: null` on PATCH means "leave it alone", so a weighted set cannot be corrected to bodyweight through this route. The log screen refuses that one edit itself, naming delete-and-re-add, rather than sending a request that would succeed and change nothing. Widening the route to tell absent from explicitly-null is tracked separately; it is a contract decision, not a screen fix.)

(Recorded in #105: DELETE /api/me/sets/:id closes the gap it leaves — sets above the removed one shift down within the same (session, exercise), in one transaction, so a session's set numbers stay 1..n. The alternative, treating set_number as a label and leaving a hole, would be right if the number were an identifier; it is not. PATCH already lets a client rewrite it, /api/me/last groups by it, and the log screen aligns its last-time strip on it, so a gap silently misaligns last week's set 2 against this week's set 3. The case this endpoint exists for is the duplicate a double-tap creates (see Idempotency below), and being left looking at "set 1, set 3" after fixing one reads as a lost set rather than a corrected one. Renumbering is scoped per-exercise because set numbers are; deleting a squat set leaves the presses alone.)

(Recorded in #102: the session summary on GET /api/me/history carries `program_day_id`, so a client can identify its own session for a given day from a read. Before it, POST /api/me/sessions was the only route that resolved (client, performed_on, program_day_id) — and that route writes, so the log screen could not learn a row already existed until it had posted into it. Consequences of that gap, all now closed at mount: set numbering restarted at 1 on a reopened day, and GET /api/me/last's self-session filter had no session id to compare against, so the client's own earlier sets from today were shown back to her as "last time". Null for freestyle sessions, which by design have no day to match on and are left unconstrained by #98's index.)

(Recorded in #98: POST /api/me/sessions is idempotent on (client_id, performed_on, program_day_id) — an existing row is returned with a 200 rather than duplicated. Since #45 the row is created by the first logged set, so a reopened tab or a second device would otherwise split one workout across two rows and leave /api/me/last answering with half a session. The same program day twice in one calendar day is not a real scenario; Day A in the morning and Day B in the evening is, and differs by program_day_id. Backed by a partial unique index on the triple, filtered to `program_day_id IS NOT NULL`: freestyle sessions stay deliberately unconstrained, and since Postgres treats NULLs as distinct an unfiltered index would not have constrained them anyway while appearing to. The index is the guarantee and the pre-insert lookup is only a fast path — a lost race is caught as a unique violation and re-read, so the loser of a double-tap gets the winning row rather than a 500. A resumed session keeps the comment it already had; POST never overwrites it, PATCH (#96) is how it changes.)

(Recorded in #96: PATCH /api/me/sessions/:id exists because the comment is authored *during* a workout while the row is created at its start (the first logged set), so POST is no longer the moment the note is finished. It accepts `comment` only — `performed_on` and `program_day_id` are what the session is, and changing either makes it a different session rather than an edited one. Extending #32's rule, the window is measured against `workout_sessions.created_at`, the entry event, not `performed_on`; a retroactively logged workout is therefore annotatable through the day it was entered. Divergence from the set patch, where a null field means "leave it alone": with one field in the body that reading makes the request a no-op and leaves no way to retract a note, so the body is the new value and null or blank clears it. A body carrying `performed_on` or `program_day_id` is refused whole with a 400 under the unknown-fields rule rather than silently narrowed to the comment.)

| GET /api/me/history?exercise_id=&before=&limit= | past sessions / per-exercise history | powers "what did I do last time." Cursor pagination (before = logged_at), not offset. Each item's session summary carries program_day_id (null = freestyle) |
| GET /api/me/last?exercise_id= | most recent sets for an exercise | the gym-floor query; kept separate and fast |

(Recorded in #33: (1) /api/me/last returns sets from the single most-recent session containing the exercise, grouped by set_number — matches the coaching "last time I did X" mental model. Isolation from cross-tenant exercise_ids is enforced by query shape (client-scoped join yields empty), collapsing "not yours" and "never done" into the same mostRecent: null. Third identity-leak convention alongside route-param 404 and body-field 400. (2) Query-string params on both endpoints are snake_case (exercise_id, before) matching the AC spec; JSON body fields remain camelCase everywhere else — the surface has two conventions by design.)

**Decision — `/api/me/*` namespace for client routes:** the URL never contains the client's own id, so there is nothing to tamper with. The IDOR surface for client self-service is structurally zero. (Rejected: `/api/clients/:id/...` shared with trainer routes — every route becomes an ownership check that can be forgotten.)

## Pause endpoints (unauthenticated, token-bearing — per notifications.md)

- GET /api/pause?token= → validates HMAC token, renders confirmation state
- POST /api/pause → consumes token, sets schedule enabled=false

#22: login rejections (unknown/wrong-password/client-email/deactivated) are byte-identical 401s with dummy-hash timing parity. Logout is unauthenticated-tolerant — always 200 + cookie clear — to avoid trapping users with dead cookies; revocation is server-side via revoked_at.

(Resolved in #40: the pause token is a stateless HMAC (schedule_id + expiry + untransmitted purpose label, all inside the MAC), 30-day lifetime, no server-side row. "Consumes" in the original wording is therefore inaccurate — POST is idempotent, and a replay within the lifetime re-pauses. The narrow consequence: if the trainer re-enables and an old link is replayed, reminders pause again. True single-use would require a consumed-token table and migration, which costs more than the bug. Statelessness is also what makes the scanner-safe GET free. Rate limiting reuses the policy still named MagicLinkIpPolicy, which now covers magic-link, login, and pause.)

(Recorded in #49: success and already-paused are not distinguishable to the client. GET returns valid: true for a paused schedule, and POST reports success either way — which is what makes replay harmless. Distinguishing them would require returning the prior enabled value, handing a link-holder a read on a schedule they otherwise only write to. The terminal state is worded as a statement about the resulting state rather than a claim about what this request changed.)

## Cross-cutting

- **Rate limiting:** only auth + pause endpoints in v1. Authenticated traffic from 4 users does not need throttling; adding it everywhere is ceremony.
(Implemented in #23: built-in ASP.NET rate limiting, in-memory — per-instance counters, reset on restart, limits multiply on scale-out; acceptable single-instance per architecture.md. Per-email limiting is in-handler (middleware can't read the body), keys on the submitted string regardless of account existence, and is deliberately magic-link-only — a login lockout would be an account-DoS vector, and Argon2 cost bounds password guessing. The 10/IP/hour policy covers magic-link and login. Pause endpoints inherit coverage at #40.)
- **Validation:** schema-validated bodies at the edge (zod or equivalent); unknown fields rejected, not ignored — silent-ignore hides client bugs.
- **CORS:** same-origin deployment planned (client served by/with the API); if split-origin later, allowlist exactly one origin, credentials mode. No wildcard, ever, with cookie auth.
- **Idempotency:** POST /sessions/:id/sets is not idempotent and doesn't need to be in v1 (double-tap creates a duplicate set the client can delete same-day). Noted as the honest gap; client-side disable-on-submit mitigates. (Contrast: notification sends, where duplication is systemic — that's why idempotency lives there.)

## Non-goals (v1)

- Public API, API keys, third-party consumers
- /v1 versioning, HATEOAS, OpenAPI generation (a hand-kept route table is enough at 25 routes)
- Websockets / realtime (no messaging in v1)
- Offset pagination, search, filtering beyond history params
- Generation via @hey-api/openapi-ts — openapi-typescript peer-conflicts with TS 6.
