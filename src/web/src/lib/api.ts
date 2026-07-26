import type {
  MeProgramWrapper,
  MeResponse,
  PostApiAuthMagicLinkData,
  PostApiAuthVerifyData,
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

  return (response.status === 204 ? null : await response.json()) as T
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
