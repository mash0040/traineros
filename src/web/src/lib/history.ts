import type { HistoryItem } from '../api/types.gen'

// Turning GET /api/me/history into something a person can read.
//
// The endpoint returns flat sets, newest first, each carrying its session summary and its
// exercise (api.md, #33). Nothing on the wire is grouped: a 30-set workout is 30 items that
// happen to share a session id. Assembling them back into sessions is this screen's job, and
// it lives here rather than in the component because the interesting part is a data question
// with one genuinely hard case — see "The page boundary" below.

/** One recorded set. No inputs and no last-time here: history is what happened. */
export type HistorySet = {
  id: string
  setNumber: number
  weightKg: number | null
  reps: number
}

export type HistoryExerciseGroup = {
  id: string
  name: string
  sets: HistorySet[]
}

export type HistorySession = {
  id: string
  /** YYYY-MM-DD, the client's own calendar date (database.md workout_sessions.performed_on). */
  performedOn: string
  comment: string | null
  /** Null for a freestyle session (#102). Carried because it identifies the session, not to display. */
  programDayId: string | null
  /** In the order she worked, not the order the feed hands them back. */
  exercises: HistoryExerciseGroup[]
  setCount: number
}

/**
 * The flat set feed, grouped into sessions, newest session first.
 *
 * ## The page boundary
 *
 * Pagination counts sets; the screen renders sessions. So a page can end in the middle of a
 * workout: the last three sets of Tuesday's squats come back on page 1 and the first five
 * arrive on page 2. Two things fall out of that, and they need different answers.
 *
 * **Sets of one session arriving on two pages must not become two cards.** They don't, because
 * grouping runs over every item loaded so far rather than per page, keyed by session id. Page 2
 * merges into the group page 1 opened. This also covers the (rarer) case of a session's sets
 * being non-contiguous in the feed, which keying by id handles for free and a
 * "start a new group when the id changes" scan would not.
 *
 * **A session cut by the boundary must not be shown while it is still half-loaded.** A card
 * reading "1 exercise, 3 sets" for a workout that was 5 exercises and 18 sets is not a partial
 * render, it is a wrong number, and wrong numbers are the one thing a training log cannot
 * afford. So while `hasMore` is true, the session owning the oldest loaded set is withheld: it
 * is the only group that can have more sets past the cursor. It appears, complete, on the page
 * that finishes it.
 *
 * Rejected: rendering it immediately with a "partial" marker. It puts the reader in the
 * position of knowing a number on screen is a lie and having to remember which one.
 *
 * The known limit of "the session owning the oldest loaded set is the only incomplete one": it
 * assumes a session's sets are contiguous in logged_at, so an older session cannot straddle the
 * boundary underneath a newer one. That holds because of how sets get written, not because of a
 * constraint: logged_at is server-now at write time, and the log screen holds one program day
 * per visit, so finishing Tuesday and then adding to Monday within the same feed window is not
 * a flow the app offers. If it ever becomes one, the fix is a session-scoped read, not a
 * cleverer scan here.
 */
export function groupSessions(
  items: HistoryItem[],
  { hasMore }: { hasMore: boolean },
): HistorySession[] {
  const open = new Map<
    string,
    { session: HistorySession; byExercise: Map<string, HistoryExerciseGroup> }
  >()

  for (const item of items) {
    const summary = item.session
    const exercise = item.exercise
    // Both are declared optional by the generated types and neither is ever absent in practice.
    // A set with no session or no exercise has nowhere to go, so it is dropped rather than
    // bucketed under a placeholder that would show up as a phantom card.
    if (summary?.id === undefined || exercise?.id === undefined) {
      continue
    }

    let entry = open.get(summary.id)
    if (entry === undefined) {
      entry = {
        session: {
          id: summary.id,
          performedOn: summary.performedOn ?? '',
          comment: summary.comment ?? null,
          programDayId: summary.programDayId ?? null,
          exercises: [],
          setCount: 0,
        },
        byExercise: new Map(),
      }
      open.set(summary.id, entry)
    }

    let group = entry.byExercise.get(exercise.id)
    if (group === undefined) {
      group = {
        id: exercise.id,
        // The endpoint answers with an empty name for an exercise outside the trainer's
        // library rather than omitting the row, so the set still counts and still shows.
        name: exercise.name === null || exercise.name === undefined || exercise.name === ''
          ? 'Exercise'
          : exercise.name,
        sets: [],
      }
      entry.byExercise.set(exercise.id, group)
      entry.session.exercises.push(group)
    }

    group.sets.push({
      id: item.id ?? `${summary.id}:${exercise.id}:${item.setNumber ?? group.sets.length + 1}`,
      setNumber: item.setNumber ?? group.sets.length + 1,
      weightKg: item.weightKg ?? null,
      reps: item.reps ?? 0,
    })
    entry.session.setCount += 1
  }

  const sessions = [...open.values()].map(({ session }) => {
    // The feed is newest-first, so inside a session the exercise met first is the one finished
    // last, and each exercise's sets arrive counting down. Both are turned back into the order
    // she worked in: a log read backwards is a puzzle.
    session.exercises.reverse()
    for (const group of session.exercises) {
      group.sets.sort((left, right) => left.setNumber - right.setNumber)
    }
    return session
  })

  if (!hasMore || items.length === 0) {
    return sessions
  }

  const boundary = items[items.length - 1].session?.id
  return sessions.filter((session) => session.id !== boundary)
}

/** The distinct exercises appearing in a page of history, for the filter control. */
export function exerciseOptions(items: HistoryItem[]): { id: string; name: string }[] {
  const found = new Map<string, string>()
  for (const item of items) {
    const exercise = item.exercise
    if (exercise?.id === undefined) {
      continue
    }
    if (!found.has(exercise.id)) {
      found.set(exercise.id, exercise.name === null || exercise.name === undefined || exercise.name === '' ? 'Exercise' : exercise.name)
    }
  }

  return [...found.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * "Sun, 2 Aug 2026".
 *
 * `performed_on` is a calendar date, not an instant, so it is formatted as one: the parts are
 * read off the string and rebuilt at UTC midnight, then formatted in UTC. Handing the raw
 * string to `new Date()` parses it as UTC midnight and then renders it in the browser's zone,
 * which moves a workout to the previous day for everyone west of Greenwich.
 *
 * The locale is pinned rather than taken from the browser: v1 is English-only, and an
 * unpinned locale means the date reads differently on the developer's machine than in the
 * test, which is how a date-formatting bug hides.
 */
export function formatSessionDate(performedOn: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(performedOn)
  if (parts === null) {
    return performedOn
  }

  const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])))
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

/**
 * "2 exercises · 11 sets" — what a collapsed session says about itself.
 *
 * Shared by the two surfaces that render one: the client's own History (#48) and the trainer's
 * view of their log (#142). One string, because it is the same sentence about the same session
 * and two copies would be two chances for "1 exercises".
 *
 * `separator` is the caller's because the two channels want different ones: the eye reads a
 * middot cleanly and a screen reader does not, so the visible summary passes '·' and the
 * accessible name passes ','.
 */
export function sessionSummary(session: HistorySession, separator: string): string {
  const exercises = count(session.exercises.length, 'exercise', 'exercises')
  const sets = count(session.setCount, 'set', 'sets')
  return `${exercises}${separator} ${sets}`
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`
}
