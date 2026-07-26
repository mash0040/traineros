// The in-progress workout, held on the device until it becomes a row.
//
// Why this exists at all (#47 decision 2): the gym-floor failure is a phone that locks
// between sets. When she reopens the app the tab has been evicted and every piece of React
// state is gone. Whatever survives that has to survive it outside React.
//
// This is not the auth exception. #42 settled that auth state comes from GET /api/me and
// never from storage, because a cached "signed in" flag outlives a revoked session. Nothing
// here is a credential or a claim: it is a note the client typed, echoed back to the same
// device. Every write it eventually causes is authorised by the httpOnly cookie at the
// moment of the write, not by anything read from here.
//
// Scoped to one draft, not a list. A client is doing one workout at a time, and a keyed
// collection would be a cache to invalidate for a case that cannot happen.

const KEY = 'traineros.workout-draft.v1'

export type WorkoutDraft = {
  /** Local calendar date the draft belongs to, YYYY-MM-DD, per the client's own timezone. */
  performedOn: string
  /** The program day being worked. Null is reserved for a freestyle session (database.md). */
  programDayId: string | null
  comment: string
}

/**
 * The client's own calendar date as YYYY-MM-DD.
 *
 * Read from `users.timezone` rather than the browser's zone. That value is what the rest of
 * the system already resolves local time against — the reminder scheduler picks send times
 * with it (notifications.md §Scheduler) and PATCH /api/me/sets measures its same-day edit
 * window with it (api.md #32). A session stamped from the browser's zone could land on a
 * different date than the window that governs editing its own sets.
 */
export function todayIn(timezone: string | null | undefined): string {
  // 'en-CA' is the locale whose short date format is already ISO, so there is no manual
  // zero-padding to get wrong. Intl throws on an unknown zone; a client whose stored
  // timezone the browser's ICU data does not carry still gets a usable date.
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone ?? undefined }).format(new Date())
  } catch {
    return new Intl.DateTimeFormat('en-CA').format(new Date())
  }
}

/**
 * The stored draft, but only if it is still the draft for this workout.
 *
 * A record for yesterday, or for a different day of the program, is not a resume — it is
 * litter from a session that ended some other way. It is dropped rather than offered,
 * because restoring Tuesday's note into Thursday's workout is worse than losing it.
 */
export function readDraft(performedOn: string, programDayId: string | null): WorkoutDraft | null {
  const stored = read()
  if (stored === null) {
    return null
  }

  if (stored.performedOn !== performedOn || stored.programDayId !== programDayId) {
    clearDraft()
    return null
  }

  return stored
}

export function writeDraft(draft: WorkoutDraft): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(draft))
  } catch {
    // Private-mode Safari, a full quota, storage disabled by policy. The cost of failing
    // here is that a reopened tab starts with an empty note; it is not worth taking the
    // screen down for, and there is nothing the client could do about it anyway.
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // As above.
  }
}

function read(): WorkoutDraft | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return null
  }

  if (raw === null) {
    return null
  }

  // Anything in localStorage is attacker-adjacent input in the sense that matters here: a
  // previous version of this app wrote it, or a devtools console did. It is validated in
  // full rather than cast, so a shape change ships as "the draft is gone" and not as a
  // screen that crashes on every load with no way to clear it.
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }

    const { performedOn, programDayId, comment } = parsed as Record<string, unknown>
    if (typeof performedOn !== 'string' || typeof comment !== 'string') {
      return null
    }
    if (programDayId !== null && typeof programDayId !== 'string') {
      return null
    }

    return { performedOn, programDayId, comment }
  } catch {
    return null
  }
}
