import type {
  ClientResponse,
  ClientSessionResponse,
  HistoryResponse,
  LastResponse,
  LoggedSetResponse,
  MeProgramWrapper,
  MeResponse,
  PatchApiClientsByIdData,
  PatchApiMeSessionsByIdData,
  PostApiAuthMagicLinkData,
  PostApiClientsData,
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
 * GET /api/clients/:id/sessions. Every session that client has ever logged, newest first.
 *
 * There is no limit parameter and no summary field on the roster, so this is also the only
 * way to answer "when did they last train" — see the Clients screen for what that costs and
 * when it stops being acceptable.
 */
export function fetchClientSessions(clientId: string): Promise<ClientSessionResponse[]> {
  return request<ClientSessionResponse[]>(
    `/api/clients/${encodeURIComponent(clientId)}/sessions`,
  )
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
