import type {
  ClientResponse,
  ExerciseResponse,
  HistoryResponse,
  PrescriptionResponse,
  ProgramDayResponse,
  ProgramDetailResponse,
  ProgramResponse,
  ScheduleResponse,
  LastResponse,
  LoggedSetResponse,
  MeProgramWrapper,
  MeResponse,
  PatchApiClientsByIdData,
  PatchApiDayExercisesByIdData,
  PatchApiExercisesByIdData,
  PatchApiDaysByIdData,
  PatchApiMeSessionsByIdData,
  PatchApiMeSetsByIdData,
  PatchApiProgramsByIdData,
  PatchApiSchedulesByIdData,
  PostApiAuthMagicLinkData,
  PostApiClientsByIdScheduleData,
  PostApiClientsData,
  PostApiDaysByIdExercisesData,
  PostApiExercisesData,
  PostApiProgramsByIdDaysData,
  PostApiProgramsData,
  PostApiAuthVerifyData,
  PostApiMeSessionsByIdSetsData,
  PostApiMeSessionsData,
  PostApiPauseData,
  SessionResponse,
  TokenValidityResponse,
} from '../api/types.gen'

// The whole fetch layer.
//
// It lives in src/lib, not src/api, because src/api is the generator's output directory and
// openapi-ts empties it on every run. This file was written there first and `npm run
// generate:types` deleted it without a word. Nothing hand-written goes in src/api.
//
// Deliberately not a generated runtime client (openapi-ts is configured types-only) and
// deliberately not react-query: v1 has nine screens, no shared server cache, and no
// background refetching. When a screen needs cache invalidation across routes, that is the
// moment to reach for a library, not before.
//
// Two rules this layer exists to enforce, in one place rather than per screen:
//   1. credentials on every request. The session cookie is httpOnly, so the SPA can neither
//      read nor attach it by hand; it rides along only if fetch is told to include it.
//   2. one error shape. api.md §Cross-cutting returns { error: { code, message } } on every
//      failure, so screens branch on a code, never on a status-string they parsed themselves.

/** api.md's single error envelope. */
export class ApiError extends Error {
  // Fields declared and assigned rather than written as constructor parameter properties:
  // tsconfig sets erasableSyntaxOnly, so only syntax a type-stripper can delete is allowed.
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  /** True when the caller is simply not signed in, which is routing information, not a failure. */
  get isUnauthenticated(): boolean {
    return this.status === 401
  }
}

const GENERIC_MESSAGE = 'Something went wrong. Try again.'

async function readError(response: Response): Promise<ApiError> {
  try {
    const body: unknown = await response.json()
    const envelope =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error: unknown }).error
        : null

    if (typeof envelope === 'object' && envelope !== null) {
      const { code, message } = envelope as { code?: unknown; message?: unknown }
      return new ApiError(
        response.status,
        typeof code === 'string' ? code : 'unknown',
        // The server's message is written for the person reading it (api.md keeps them
        // human), so it is shown as-is rather than remapped per screen.
        typeof message === 'string' ? message : GENERIC_MESSAGE,
      )
    }
  } catch {
    // Non-JSON body: a proxy error page, or the API being down. Fall through.
  }

  return new ApiError(response.status, 'unknown', GENERIC_MESSAGE)
}

// T comes from types.gen.ts, so it is the OpenAPI contract rather than a runtime guarantee.
// That is the same trust any generated client asks for, and it is only trustworthy because
// the endpoints now declare .Produces<T>(): before that, every response type was `unknown`
// and each caller narrowed by hand.
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  return (await requestDetailed<T>(url, init)).body
}

/**
 * As `request`, but keeps the status code.
 *
 * Only one caller needs it: POST /api/me/sessions answers 201 when it created the row and 200
 * when it handed back an existing one (#98), and the difference decides whether the log screen
 * has to read back what is already in that session. Kept as a status rather than mirrored into
 * a `resumed` field on the body, because two sources for one fact eventually disagree.
 */
async function requestDetailed<T>(
  url: string,
  init: RequestInit = {},
): Promise<{ body: T; status: number }> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      // Same-origin in production (one App Service serves API and SPA) and through Vite's
      // /api proxy in dev, so the cookie is first-party in both.
      credentials: 'same-origin',
      headers: init.body === undefined ? init.headers : { 'Content-Type': 'application/json', ...init.headers },
    })
  } catch {
    // Offline, DNS, connection refused: no status to report.
    throw new ApiError(0, 'network', GENERIC_MESSAGE)
  }

  if (!response.ok) {
    throw await readError(response)
  }

  const body = (response.status === 204 ? null : await response.json()) as T
  return { body, status: response.status }
}

/** POST /api/auth/magic-link. Always 202 whether or not the email exists (api.md #20). */
export async function requestMagicLink(email: string): Promise<void> {
  const body: PostApiAuthMagicLinkData['body'] = { email }
  await request<unknown>('/api/auth/magic-link', { method: 'POST', body: JSON.stringify(body) })
}

/** GET /api/auth/verify. Validates only; never consumes the token (api.md #21). */
export async function checkMagicLink(token: string): Promise<boolean> {
  const body = await request<TokenValidityResponse>(`/api/auth/verify?token=${encodeURIComponent(token)}`)
  return body.valid === true
}

/** POST /api/auth/verify. Consumes the token and sets the session cookie. */
export async function consumeMagicLink(token: string): Promise<void> {
  const body: PostApiAuthVerifyData['body'] = { token }
  await request<unknown>('/api/auth/verify', { method: 'POST', body: JSON.stringify(body) })
}

// -- Trainer roster (#25). Every route below is trainer-only and scoped to the session's
// trainer, so none of them takes an owning-trainer id: there is nothing for a caller to
// tamper with, the same structural argument the /api/me/* namespace rests on.

/** GET /api/clients. The roster, already ordered by display name. Includes deactivated clients. */
export function fetchClients(): Promise<ClientResponse[]> {
  return request<ClientResponse[]>('/api/clients')
}

/**
 * POST /api/clients. Creates the client row and sends nothing.
 *
 * api.md is explicit that this has no email side effect: the invite is the trainer telling
 * them to log in. So a 201 here is not "they have been notified", and the screen must not
 * say it was.
 *
 * 409 email_taken is the one rejection worth handling by itself — it is the only one the
 * trainer can act on, by using the address the client already has.
 */
export function createClient(body: PostApiClientsData['body']): Promise<ClientResponse> {
  return request<ClientResponse>('/api/clients', { method: 'POST', body: JSON.stringify(body) })
}

/**
 * PATCH /api/clients/:id. Edit, or flip is_active.
 *
 * Deactivating is not only a flag: the endpoint disables the client's reminder schedules in
 * the same transaction. Reactivating does not turn them back on, and nothing here pretends
 * otherwise — that asymmetry belongs to #25 and is surfaced in the UI copy instead.
 */
export function updateClient(
  clientId: string,
  body: PatchApiClientsByIdData['body'],
): Promise<ClientResponse> {
  return request<ClientResponse>(`/api/clients/${encodeURIComponent(clientId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/**
 * GET /api/clients/:id/history. What a client actually lifted, for their trainer (#142).
 *
 * The same page shape GET /api/me/history returns, so `lib/history.ts`'s `groupSessions` works
 * on it unchanged — including the page-boundary rule, which is the part worth not writing
 * twice. Weights come back as canonical kilograms; the reader's unit is the *client's*, read
 * from the roster row the screen already has.
 */
export function fetchClientHistory(
  clientId: string,
  options: { before?: string; limit?: number } = {},
): Promise<HistoryResponse> {
  const params = new URLSearchParams()
  if (options.before !== undefined) {
    params.set('before', options.before)
  }
  if (options.limit !== undefined) {
    params.set('limit', String(options.limit))
  }

  const query = params.toString()
  return request<HistoryResponse>(
    `/api/clients/${encodeURIComponent(clientId)}/history${query === '' ? '' : `?${query}`}`,
  )
}

/**
 * GET /api/programs. Every program this trainer owns, across all their clients.
 *
 * There is no per-client programs route, so the client detail screen filters this by
 * `clientId`. At v1 scale (one trainer, a handful of clients, a few programs each) that is a
 * smaller response than a dedicated endpoint would be worth.
 */
export function fetchPrograms(): Promise<ProgramResponse[]> {
  return request<ProgramResponse[]>('/api/programs')
}

// -- Program builder (#28 writes, tree read from #78) -------------------------------------

/**
 * GET /api/programs/:id. The program with its days, their prescriptions, and each
 * prescription's exercise, in one request.
 *
 * The builder reads the whole tree once and then keeps its own copy in step from what the
 * write endpoints return, rather than re-reading after every save. A refetch per keystroke-save
 * would be correct and would also throw away focus and scroll position on a screen whose whole
 * job is a long sequence of small edits.
 */
export function fetchProgram(programId: string): Promise<ProgramDetailResponse> {
  return request<ProgramDetailResponse>(`/api/programs/${encodeURIComponent(programId)}`)
}

/** POST /api/programs. `clientId` is required; status defaults to draft server-side. */
export function createProgram(body: PostApiProgramsData['body']): Promise<ProgramResponse> {
  return request<ProgramResponse>('/api/programs', { method: 'POST', body: JSON.stringify(body) })
}

/**
 * PATCH /api/programs/:id. Title, notes, dates, and the status transition.
 *
 * Status is unrestricted between draft/active/archived (#27) with one structural gate: a client
 * may have only one active program, enforced by a partial unique index, so activating a second
 * is a 409 program_active_conflict rather than a silent swap.
 */
export function updateProgram(
  programId: string,
  body: PatchApiProgramsByIdData['body'],
): Promise<ProgramResponse> {
  return request<ProgramResponse>(`/api/programs/${encodeURIComponent(programId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/**
 * DELETE /api/programs/:id. 204, or 409 `program_has_history` (#118).
 *
 * The refusal is the endpoint's real content. Its days and their prescriptions cascade, and
 * both references into them are ON DELETE SET NULL, so the database would take this delete on
 * a trained program and leave every logged session and set standing but pointing at nothing.
 * Archive is the disposal path for a program that has been trained against, and it keeps those
 * references intact; this exists for the other case, the program built by mistake.
 *
 * The 409's message names which reference exists (sessions against its days, or sets against
 * its prescriptions) and points at archive, so it is rendered as-is rather than remapped.
 */
export async function deleteProgram(programId: string): Promise<void> {
  await request<null>(`/api/programs/${encodeURIComponent(programId)}`, { method: 'DELETE' })
}

/** POST /api/programs/:id/days. Position is server-assigned to the end; reordering is #54. */
export function createDay(
  programId: string,
  body: PostApiProgramsByIdDaysData['body'],
): Promise<ProgramDayResponse> {
  return request<ProgramDayResponse>(`/api/programs/${encodeURIComponent(programId)}/days`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** PATCH /api/days/:id. Title here; `position` belongs to the reorder flow (#54). */
export function updateDay(
  dayId: string,
  body: PatchApiDaysByIdData['body'],
): Promise<ProgramDayResponse> {
  return request<ProgramDayResponse>(`/api/days/${encodeURIComponent(dayId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/**
 * DELETE /api/days/:id. 204.
 *
 * The day's prescriptions go with it (ON DELETE CASCADE), but the client's logged history does
 * not: workout_sessions.program_day_id and logged_sets.program_day_exercise_id are both
 * ON DELETE SET NULL (#17, database.md principle 4), so past sessions and sets survive with
 * their references cleared. The screen says so before asking.
 */
export async function deleteDay(dayId: string): Promise<void> {
  await request<null>(`/api/days/${encodeURIComponent(dayId)}`, { method: 'DELETE' })
}

/**
 * GET /api/exercises. The trainer's whole library, active and retired alike.
 *
 * #26 soft-deletes rather than removing, and the list deliberately returns both so a trainer
 * can bring one back. The picker filters to active on its own, because #28 refuses a retired
 * exercise on a new prescription with 400 unknown_exercise — offering one would be offering a
 * choice the server has already decided against.
 */
export function fetchExercises(): Promise<ExerciseResponse[]> {
  return request<ExerciseResponse[]>('/api/exercises')
}

/** POST /api/exercises. 201. Name is required; the video URL and cues are not. */
export function createExercise(body: PostApiExercisesData['body']): Promise<ExerciseResponse> {
  return request<ExerciseResponse>('/api/exercises', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * An optional text field's wire value: the trimmed string, or null when it is empty.
 *
 * #145 made null the one way to clear a nullable column, on every type rather than only on
 * strings. This is the form's half of that: a field the trainer emptied means "no value", and
 * "no value" is null. Written once rather than at each call site, because the alternative is
 * five call sites each deciding what an empty input means.
 *
 * Deliberately not applied to required fields. `name`, `targetReps` and `title` back NOT NULL
 * columns, so null on those is a 400 rather than a clear, and their forms refuse an empty value
 * before it gets this far.
 */
export function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * PATCH /api/exercises/:id. Also the delete route: there is no DELETE.
 *
 * #145's convention, and the reason callers must be deliberate about what they put in the body:
 * a field that is absent is left alone, and a field sent as `null` is cleared. Since
 * JSON.stringify drops `undefined` keys, "absent" is what an omitted property produces — so
 * `{ isActive: false }` retires an exercise without touching its video URL or cues, while
 * `{ isActive: false, videoUrl: null }` would retire it *and* wipe the link.
 *
 * This replaces #26's blank-string sentinel, under which `videoUrl: ''` did the clearing. That
 * rule only ever worked on strings, which is why weight_kg, rest_seconds and starts_on could be
 * set and never cleared. `''` now means an empty string and is stored as one.
 *
 * The two callers therefore send different bodies on purpose: the edit form sends every text
 * field it owns (so emptying one clears it, via `orNull`), and the retire/restore control sends
 * only isActive.
 */
export function updateExercise(
  exerciseId: string,
  body: PatchApiExercisesByIdData['body'],
): Promise<ExerciseResponse> {
  return request<ExerciseResponse>(`/api/exercises/${encodeURIComponent(exerciseId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/**
 * POST /api/days/:id/exercises. Adds one prescription to the end of a day.
 *
 * exercise_id, target_sets and target_reps are required; load, rest and note are not, and are
 * left to the row editor rather than crowded into the add form.
 */
export function createPrescription(
  dayId: string,
  body: PostApiDaysByIdExercisesData['body'],
): Promise<PrescriptionResponse> {
  return request<PrescriptionResponse>(`/api/days/${encodeURIComponent(dayId)}/exercises`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * PATCH /api/days/:id/order. 204.
 *
 * Takes the day's complete prescription id list in the order wanted, and the server rewrites
 * positions 1..N in one transaction. Anything less than complete is a 400: duplicates, missing
 * ids, and ids from another day are all rejected as a whole, because a partial reorder is how
 * positions drift into gaps and ties (api.md rejects fractional positions for the same reason).
 *
 * So callers send every id every time, even to move one row one place.
 */
export async function reorderDayExercises(dayId: string, orderedIds: string[]): Promise<void> {
  await request<null>(`/api/days/${encodeURIComponent(dayId)}/order`, {
    method: 'PATCH',
    body: JSON.stringify({ orderedIds }),
  })
}

/**
 * PATCH /api/day-exercises/:id.
 *
 * Blank string clears a nullable text field to NULL; omitting it leaves the field alone. That
 * convention is #28's and it is why the edit form sends every field it owns on every save.
 */
export function updatePrescription(
  prescriptionId: string,
  body: PatchApiDayExercisesByIdData['body'],
): Promise<PrescriptionResponse> {
  return request<PrescriptionResponse>(`/api/day-exercises/${encodeURIComponent(prescriptionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/**
 * DELETE /api/day-exercises/:id. 204.
 *
 * logged_sets.program_day_exercise_id is ON DELETE SET NULL, so a set the client already
 * logged survives, keyed by its always-set exercise_id.
 */
export async function deletePrescription(prescriptionId: string): Promise<void> {
  await request<null>(`/api/day-exercises/${encodeURIComponent(prescriptionId)}`, { method: 'DELETE' })
}

/**
 * GET /api/clients/:id/schedule, with "no schedule yet" as null rather than a thrown 404.
 *
 * #29 returns 404 for both "this client has no schedule" and "not your client", deliberately —
 * the scoped query cannot tell them apart and the roster is where ownership is learned. The
 * caller here has already found the client in its own roster, so for this screen the 404 can
 * only mean the first, and it is an ordinary empty state rather than an error.
 *
 * Contrast GET /api/me/program, which expresses the same idea as `{ program: null }` with a
 * 200. The two endpoints disagree; this function is where that disagreement stops.
 */
export async function fetchClientSchedule(clientId: string): Promise<ScheduleResponse | null> {
  try {
    return await request<ScheduleResponse>(
      `/api/clients/${encodeURIComponent(clientId)}/schedule`,
    )
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null
    }
    throw error
  }
}

/**
 * POST /api/clients/:id/schedule. One schedule per client in v1, so this is create-only —
 * a second call answers 409 schedule_exists rather than replacing the first.
 *
 * `sendTime` must be HH:mm:ss: the server binds it to a TimeOnly and an HH:mm string is a 400
 * (#29). See lib/scheduleTime.ts, which is the only place that conversion happens.
 */
export function createClientSchedule(
  clientId: string,
  body: PostApiClientsByIdScheduleData['body'],
): Promise<ScheduleResponse> {
  return request<ScheduleResponse>(`/api/clients/${encodeURIComponent(clientId)}/schedule`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * PATCH /api/schedules/:id. Time, days, and the enabled switch.
 *
 * The enabled switch is the one #25 turns off on deactivation and never turns back on, so this
 * call is the only way a paused client's reminders resume — whether they paused themselves
 * from an emailed link (#40) or the trainer deactivated and later reactivated them (#50).
 */
export function updateSchedule(
  scheduleId: string,
  body: PatchApiSchedulesByIdData['body'],
): Promise<ScheduleResponse> {
  return request<ScheduleResponse>(`/api/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/**
 * GET /api/pause. Validates the emailed token and mutates nothing (#40).
 *
 * The same shape as GET /api/auth/verify, and deliberately so: notifications.md resolved
 * question 2 and api.md §GET /api/auth/verify are the same rule applied twice, so both token
 * screens answer "is this link good?" with `{ valid }` and branch identically.
 */
export async function checkPauseLink(token: string): Promise<boolean> {
  const body = await request<TokenValidityResponse>(`/api/pause?token=${encodeURIComponent(token)}`)
  return body.valid === true
}

/**
 * POST /api/pause. Consumes the token and sets notification_schedules.enabled = false.
 *
 * The only call in this app that pauses reminders, and it happens on a press. Every rejection
 * (forged, expired, schedule since deleted) is one indistinguishable 401 invalid_token, so
 * there is nothing here to branch on beyond the status.
 */
export async function pauseReminders(token: string): Promise<void> {
  const body: PostApiPauseData['body'] = { token }
  await request<unknown>('/api/pause', { method: 'POST', body: JSON.stringify(body) })
}

/**
 * Who the browser currently is, as far as the server is concerned.
 *
 * `notAClient` exists because /api/me is a client-only route and the API distinguishes the
 * two rejections: no session is 401, wrong role is 404. A trainer holds a perfectly good
 * session and still gets 404 here, which is a routing fact rather than an error to show.
 */
export type Session =
  | { kind: 'client'; me: MeResponse }
  | { kind: 'notAClient' }
  | { kind: 'anonymous' }

/**
 * GET /api/me. The only source of auth state in this app.
 *
 * The session cookie is httpOnly, so "am I signed in?" is a question only the server can
 * answer. Nothing is mirrored into localStorage: a copy would be a second source of truth
 * that goes stale the moment a session is revoked server-side, and it would outlive logout.
 */
/**
 * PATCH /api/me. The one field a client may write about themselves: their weight unit (#99).
 *
 * The endpoint deliberately accepts nothing else — email is the login identity *and* the
 * reminder channel, timezone drives the trainer's reminder schedule, and is_active is not
 * self-service in either direction. See api.md; the API refuses unknown fields outright rather
 * than dropping them, so a wider body here would be a 400 rather than a silent partial write.
 *
 * Returns the full MeResponse so the caller can replace session state without a second read.
 */
export function updateMyWeightUnit(weightUnit: 'kg' | 'lb'): Promise<MeResponse> {
  return request<MeResponse>('/api/me', {
    method: 'PATCH',
    body: JSON.stringify({ weightUnit }),
  })
}

/**
 * GET /api/me/program. The active program with its days and prescriptions, or
 * `{ program: null }` when there isn't one.
 */
// api.md #30: "no active program" is a 200 with an explicit null, never a 404. So no error
// handling here for the empty case, because it isn't one; the caller renders it.
export function fetchMyProgram(): Promise<MeProgramWrapper> {
  return request<MeProgramWrapper>('/api/me/program')
}

/**
 * POST /api/me/sessions. Creates the workout_sessions row, or hands back the one that already
 * exists for this (client, performed_on, program_day_id) — #98.
 *
 * `resumed` is the caller's cue that the row may already contain sets it knows nothing about.
 * Ignoring it is how set numbering restarts at 1 on a second visit to the same day.
 */
export async function createSession(
  body: PostApiMeSessionsData['body'],
): Promise<{ session: SessionResponse; resumed: boolean }> {
  const { body: session, status } = await requestDetailed<SessionResponse>('/api/me/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  return { session, resumed: status === 200 }
}

/**
 * POST /api/me/sessions/:id/sets. One logged set.
 *
 * Not idempotent (api.md §Cross-cutting): a duplicate POST is a duplicate set. The caller owns
 * disable-on-submit, which is why this layer does no retrying of its own — a retry here would
 * be indistinguishable from a double tap.
 */
export function logSet(
  sessionId: string,
  body: PostApiMeSessionsByIdSetsData['body'],
): Promise<LoggedSetResponse> {
  return request<LoggedSetResponse>(`/api/me/sessions/${encodeURIComponent(sessionId)}/sets`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * PATCH /api/me/sets/:id (#32), called from the log screen since #107.
 *
 * Same-day window measured on `logged_at` in the client's own timezone, and missing it is a
 * 404 shaped exactly like a set that never existed — api.md's rule, so timing cannot be
 * probed. The caller is what knows the row was on screen a moment ago, so the caller is what
 * turns that 404 into a sentence.
 *
 * `weightKg: null` clears the weight to bodyweight (#145); omitting the field leaves it alone.
 * Until #145 those were the same request and both meant "leave it alone", so a weighted set
 * could not be corrected to bodyweight at all and the log screen refused that edit itself.
 */
export function updateSet(
  setId: string,
  body: PatchApiMeSetsByIdData['body'],
): Promise<LoggedSetResponse> {
  return request<LoggedSetResponse>(`/api/me/sets/${encodeURIComponent(setId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/**
 * DELETE /api/me/sets/:id (#105). Same-day window on logged_at, 204 on success.
 *
 * The server closes the gap it leaves: sets above the deleted one shift down, so numbering
 * stays 1..n. Callers holding a local copy have to do the same to it.
 */
export async function deleteSet(setId: string): Promise<void> {
  await request<null>(`/api/me/sets/${encodeURIComponent(setId)}`, { method: 'DELETE' })
}

/** PATCH /api/me/sessions/:id (#96). Comment only; null clears it. Same-day window on created_at. */
export function updateSessionComment(sessionId: string, comment: string | null): Promise<SessionResponse> {
  const body: PatchApiMeSessionsByIdData['body'] = { comment }
  return request<SessionResponse>(`/api/me/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/** api.md's cursor page: `before` is the loggedAt of the previous page's last item, never an offset. */
export type HistoryQuery = {
  limit: number
  before?: string | null
  exerciseId?: string | null
}

/**
 * GET /api/me/history. Two callers, one endpoint.
 *
 * The log screen reads one large page to rebuild a session it is resuming. There is no GET for
 * a single session, so "what have I already logged into this row" is answered by reading recent
 * sets and filtering on session id. That matters more than it sounds: logged_sets has no unique
 * constraint on (session_id, exercise_id, set_number), so a resume that forgot the saved sets
 * would restart numbering at 1 and write duplicates the database would happily accept.
 *
 * The history screen (#48) pages through the same feed with `before` and filters it with
 * `exercise_id`. Query params here are snake_case while JSON bodies elsewhere are camelCase;
 * that split is api.md #33's, not a slip.
 */
export function fetchHistory({ limit, before, exerciseId }: HistoryQuery): Promise<HistoryResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before !== null && before !== undefined) {
    params.set('before', before)
  }
  if (exerciseId !== null && exerciseId !== undefined) {
    params.set('exercise_id', exerciseId)
  }

  return request<HistoryResponse>(`/api/me/history?${params.toString()}`)
}

/**
 * GET /api/me/last. The sets from the most recent session containing this exercise (#33).
 *
 * `{ mostRecent: null }` covers both "never done it" and "not yours" — the client-scoped join
 * yields nothing either way, which is deliberate and means there is no branch to write here.
 *
 * Query params on this endpoint are snake_case; JSON bodies elsewhere are camelCase. That
 * split is api.md #33's, not a slip.
 */
export function fetchLastForExercise(exerciseId: string): Promise<LastResponse> {
  return request<LastResponse>(`/api/me/last?exercise_id=${encodeURIComponent(exerciseId)}`)
}

export async function loadSession(): Promise<Session> {
  try {
    return { kind: 'client', me: await request<MeResponse>('/api/me') }
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthenticated) {
      return { kind: 'anonymous' }
    }

    if (error instanceof ApiError && error.status === 404) {
      return { kind: 'notAClient' }
    }

    throw error
  }
}
