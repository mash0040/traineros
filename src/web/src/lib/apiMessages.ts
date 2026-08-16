import { ApiError } from './api'

// Trainer-facing error copy, owned by the SPA. DESIGN.md §Messages.
//
// ── Why this exists ────────────────────────────────────────────────────────────────────────
// Until now every trainer screen rendered `caught.message` verbatim. Those strings were written
// across a dozen endpoint tickets as developer explanations, and they reach the trainer exactly
// as written: "Unknown exercise_id.", "Not Found", "ordered_ids contains duplicates."
//
// The `code` is the contract (api.md lists it); the `message` is prose any API ticket may
// reword without telling anyone. So the map keys on the code, and the server's message is the
// fallback rather than the source.
//
// ── The test for whether an entry belongs here ──────────────────────────────────────────────
// The SPA maps a code when it knows something the API cannot. That is the whole justification,
// and it is worth applying strictly, because a map that restates the server's sentence in
// different words is a second copy of the same string that will drift out of step with it.
//
// The canonical case is `unknown_exercise`. The server knows the id is not selectable. Only the
// SPA knows the trainer is staring at a picker it populated before the exercise was retired, so
// only the SPA can say "reload to see the current library" — a sentence no server string could
// have known to write.
//
// ── Why `bad_request` is deliberately not mapped ────────────────────────────────────────────
// One code covers ~27 distinct validation failures across the API: "name is required.",
// "target_sets must be a positive integer.", "days_of_week must not contain duplicates.",
// "Please enter a valid email address.", and so on. A single rewrite of `bad_request` would
// have to say something like "Check the form" — strictly less than every string it replaced,
// because the server is the only layer that knows which field it rejected.
//
// It matters less than it looks. Every trainer form validates the same conditions client-side
// before it sends, so the reachable `bad_request` responses are the ones where the two layers
// disagree in strictness, and the email rule (#114) is the deliberate example: the server's
// sentence there is already written for a person. The rest are the safety net for a rule that
// drifts, which is exactly when the server's specific message is the one worth showing.
//
// Fixing this properly means splitting `bad_request` into per-field codes. That is an API
// change, not a web one.

/**
 * What the trainer was acting on, so one code can read differently in two places.
 *
 * `not_found` is why this is needed: the server answers a bare "Not Found" for a program, a
 * day, a client, and an exercise alike, and "that's gone" is only useful if it names what.
 */
export type MessageContext =
  | 'client'
  | 'schedule'
  | 'program'
  | 'day'
  | 'prescription'
  | 'exercise'

/** Shown when there is no code to key on at all: a thrown TypeError, a bug, a non-Error. */
const GENERIC = 'Something went wrong. Try again.'

// Looked up as `${context}:${code}` first, then bare `code`. Nothing here ends in an em dash or
// contains one: DESIGN.md §Absolute bans applies to copy in a map exactly as it does to copy in
// a component.
const COPY: Record<string, string> = {
  // ── Stale reads: the row was there when the screen loaded and is not there now ────────────
  // All of these mean the same thing mechanically (someone changed it in another tab, or on a
  // phone, or the trainer left this page open over lunch) and the useful half of the sentence
  // is the same every time: what to do about it.
  'client:not_found': 'This client is no longer on your roster. Reload to see who is.',
  'schedule:not_found': 'This reminder schedule no longer exists. Reload the page and set it up again.',
  'program:not_found': 'This program no longer exists. Go back to the client to see their programs.',
  'day:not_found': 'This day has already been deleted. Reload to see the current program.',
  'prescription:not_found': 'This exercise is no longer on this day. Reload to see the current program.',
  'exercise:not_found': 'This exercise is no longer in your library. Reload to see what is there.',
  // The safety net. Never shown if the call sites pass a context, but the server's own string
  // here is the bare HTTP reason phrase, so an unmapped path must not fall through to it.
  not_found: 'That is no longer there. Reload the page to see the current state.',

  // ── The picker offering something the server refuses (#26 soft-delete, #28's 400) ─────────
  // The single clearest case for SPA-owned copy. "Unknown exercise_id." is true and useless:
  // the trainer picked it from a list this screen drew, so from where they sit the id is not
  // unknown at all. What actually happened is that the library changed underneath the list.
  unknown_exercise: 'That exercise was retired, so it cannot be added. Reload to see the current library.',
  unknown_program_day: 'That day was deleted. Reload to see the current program.',
  unknown_program_day_exercise: 'That exercise was already removed from this day. Reload to see the current program.',
  unknown_client: 'That client is no longer on your roster. Reload to see who is.',

  // ── Conflicts: the write was understood and refused on a rule ─────────────────────────────
  // The server names the conflict; the SPA adds what to do about it, which is the half the API
  // has no business knowing. This replaces a string concatenation that ProgramStatus was doing
  // inline against the server's sentence.
  program_active_conflict:
    'This client already has an active program. Archive that one first, then activate this.',
  // `program_has_history` (#118) is deliberately absent, and it is the closest call in this file.
  // There is something the SPA knows: the Archived button is a few hundred pixels up the same
  // screen, which no server string can know to mention. But that code carries *two* sentences —
  // the API says whether the block is workouts logged against the program's days or sets logged
  // against its exercises — and a map entry keys on the code, so it would replace both with one
  // vaguer line. The specific reason is worth more to a trainer than the pointer to a control
  // already in front of them, and it is the half only the server can compute.
  schedule_exists: 'This client already has a reminder schedule. Reload the page to edit it.',
  email_taken: 'That email is already in use. Check whether they are already on your roster.',

  // ── Infrastructure. None of these are about what the trainer typed ────────────────────────
  // 'network' is thrown by the fetch layer itself rather than returned by the API, so there is
  // no server message underneath it to fall back to.
  network: 'We could not reach the server. Check your connection and try again.',
  rate_limited: 'Too many requests just now. Wait a moment and try again.',
  internal_error: 'Something went wrong on our end. Try again in a moment.',
  // Reachable on any write once a session expires mid-visit. The server says "Authentication
  // required.", which reads as an instruction the trainer cannot act on from where they are.
  unauthorized: 'Your session has ended. Reload the page to sign in again.',
  invalid_token: 'That link is no longer valid. Ask for a new one.',
}

/**
 * The sentence to show a trainer for a failed call.
 *
 * Resolution order, and each step exists for a reason:
 *   1. `${context}:${code}` — copy that depends on what was being acted on.
 *   2. `code` — copy that reads the same everywhere.
 *   3. The server's own message — for codes the SPA has nothing to add to, `bad_request` above
 *      all. Not a gap in the map; the design (see the header).
 *   4. GENERIC — for anything that is not an ApiError, so a bug in the SPA never renders a
 *      stack-trace fragment into a form.
 *
 * `context` is required rather than optional on purpose. Every call site knows what it was
 * writing to, and the one code that most needs it is the one the server is vaguest about.
 */
export function messageFor(caught: unknown, context: MessageContext): string {
  if (!(caught instanceof ApiError)) {
    return GENERIC
  }

  const mapped = COPY[`${context}:${caught.code}`] ?? COPY[caught.code]
  if (mapped !== undefined) {
    return mapped
  }

  // Trimmed and checked, because an empty or whitespace-only message field would otherwise
  // render as an empty panel: a message-shaped hole that says a write failed without saying
  // anything, which is worse than the generic sentence.
  const fromServer = caught.message.trim()
  return fromServer === '' ? GENERIC : fromServer
}
