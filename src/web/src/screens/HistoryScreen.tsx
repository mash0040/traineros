import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import type { HistoryItem } from '../api/types.gen'
import { fetchHistory } from '../lib/api'
import {
  exerciseOptions,
  formatSessionDate,
  groupSessions,
  type HistoryExerciseGroup,
  type HistorySession,
} from '../lib/history'
import { Message } from './Message'

type Load = 'loading' | 'ready' | 'unreachable'

/**
 * How many sets to ask for per page.
 *
 * Sized in sessions, not sets: the unit on screen is a workout, and a page that holds only part
 * of one is a page that shows nothing (see groupSessions on the boundary). Fifty sets is
 * comfortably two or three real workouts, so the first page fills the screen and the second is
 * a tap away. The endpoint caps `limit` at 100.
 */
const PAGE = 50

// ui-ux.md §Client screens, History: "reverse-chron sessions; tap → session detail;
// per-exercise filter", with cursor pagination and a skeleton.
//
// ── What the API gives, and what this screen has to make of it ─────────────────────────────
// GET /api/me/history returns flat sets, newest first, each carrying its session summary and
// its exercise. Nothing is grouped on the wire, and pagination counts sets rather than
// sessions, so the interesting problem is assembling workouts out of a stream that can cut one
// in half. That work is in lib/history.ts, where the boundary rule is argued in full.
//
// ── Session detail without a session endpoint ──────────────────────────────────────────────
// "Tap → session detail" is served by expanding the card in place rather than by routing to
// /history/:id. There is no GET for a single session — the sets of a workout are only reachable
// through this feed — so a detail route would have to page backwards through history looking
// for its own id on every cold load or refresh, which is a lot of machinery to make a URL work
// and a slow screen when it does. The feed already carries every set, so the detail is in hand
// the moment the list renders: expanding costs no request and keeps the reader's place in a
// long list. DESIGN.md's ban on the modal as the first answer points the same way, and #105
// settled the same question for removing a set.
//
// ── Cards ─────────────────────────────────────────────────────────────────────────────────
// DESIGN.md names a session in history as one of the few places a card is genuinely warranted:
// the unit is bounded, it is meaningful as one object, and it is the thing being tapped. The
// three-number hierarchy from the log row deliberately does not apply — there are no inputs
// and no last-time column here, just recorded values.
export function HistoryScreen() {
  const [load, setLoad] = useState<Load>('loading')
  const [items, setItems] = useState<HistoryItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [exerciseId, setExerciseId] = useState<string | null>(null)
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)

  /**
   * Every exercise seen in any page, filtered or not, so the filter can offer them.
   *
   * Kept apart from `items` and never cleared, because the two have opposite lifetimes. Items
   * reset when the filter changes; the option list must not, or choosing "Back Squat" would
   * leave a control whose only remaining option is Back Squat.
   *
   * The client has no exercise-library route to read instead: GET /api/exercises is a trainer
   * endpoint (api.md). What she has done is the only list of exercises available to her, which
   * is also the right list — a filter offering exercises she has never logged would be all
   * empty results.
   */
  const [options, setOptions] = useState<{ id: string; name: string }[]>([])

  // Which request the screen is currently listening to. Changing the filter starts a new page 1
  // while a "load more" for the old filter may still be in flight; without this, that response
  // lands and appends another exercise's sets to a filtered list.
  const generation = useRef(0)
  // A ref rather than the state flag, so two calls in the same tick (the button and the
  // auto-continue effect below) cannot both get past the guard.
  const fetchingMore = useRef(false)

  useEffect(() => {
    const mine = ++generation.current
    fetchingMore.current = false

    setLoad('loading')
    setItems([])
    setCursor(null)
    setLoadingMore(false)
    setMoreError(null)
    setOpenSessionId(null)

    // Filtering is a server-side query, not a filter over what is already loaded. The
    // difference is the whole point of the control: "every time I have squatted" has to reach
    // past the two pages on screen into history the client has not scrolled to.
    fetchHistory({ limit: PAGE, exerciseId })
      .then((page) => {
        if (generation.current !== mine) {
          return
        }

        const fetched = page.items ?? []
        setItems(fetched)
        setCursor(page.nextCursor ?? null)
        setOptions((previous) => mergeOptions(previous, fetched))
        setLoad('ready')
      })
      .catch(() => {
        if (generation.current === mine) {
          setLoad('unreachable')
        }
      })
  }, [exerciseId, attempt])

  const loadMore = useCallback(async () => {
    if (fetchingMore.current || cursor === null) {
      return
    }

    const mine = generation.current
    fetchingMore.current = true
    setLoadingMore(true)
    setMoreError(null)

    try {
      // api.md: cursor pagination, `before` = the loggedAt the last page ended on. No offset,
      // so a set logged between the two requests cannot shift a page and hide a workout.
      const page = await fetchHistory({ limit: PAGE, before: cursor, exerciseId })
      if (generation.current !== mine) {
        return
      }

      const fetched = page.items ?? []
      setItems((previous) => [...previous, ...fetched])
      setCursor(page.nextCursor ?? null)
      setOptions((previous) => mergeOptions(previous, fetched))
    } catch {
      if (generation.current === mine) {
        // What is already on screen stays there. A dropped request for older workouts is not a
        // reason to take away the ones she is reading.
        setMoreError('We couldn’t load any more. Check your connection.')
      }
    } finally {
      fetchingMore.current = false
      if (generation.current === mine) {
        setLoadingMore(false)
      }
    }
  }, [cursor, exerciseId])

  const sessions = useMemo(
    () => groupSessions(items, { hasMore: cursor !== null }),
    [items, cursor],
  )

  // When a single workout fills an entire page, withholding it leaves nothing to render — a
  // screen with a Load more button and no history above it, which reads as "you have never
  // trained". Rather than show that, the screen keeps reading until it has a whole session.
  // The loop terminates: every page either completes the session or exhausts the cursor.
  useEffect(() => {
    if (load !== 'ready' || cursor === null || loadingMore || moreError !== null) {
      return
    }
    if (sessions.length > 0) {
      return
    }

    void loadMore()
  }, [load, cursor, loadingMore, moreError, sessions.length, loadMore])

  const filtered = exerciseId !== null
  const filteredName = options.find((option) => option.id === exerciseId)?.name ?? 'that exercise'

  return (
    <main className="flex min-h-dvh flex-col px-6 pb-16 pt-10">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col">
        <Link
          className="inline-flex min-h-[var(--tap-min)] items-center self-start text-sm font-semibold text-ink"
          to="/"
        >
          <span className="underline underline-offset-4">Back to today</span>
        </Link>

        <h1 className="mt-4 text-xl font-semibold text-ink-bold">History</h1>

        {/* Offered only once there is a choice to make. One exercise in the whole log means the
            control can only ever narrow the list to what it already shows. */}
        {options.length > 1 && (
          <ExerciseFilter chosenId={exerciseId} onChoose={setExerciseId} options={options} />
        )}

        {load === 'loading' ? (
          <HistorySkeleton />
        ) : load === 'unreachable' ? (
          <Unreachable onRetry={() => setAttempt((previous) => previous + 1)} />
        ) : sessions.length > 0 ? (
          <ul className="mt-6 grid gap-3">
            {sessions.map((session) => (
              <SessionCard
                key={session.id}
                onToggle={() =>
                  setOpenSessionId((previous) => (previous === session.id ? null : session.id))
                }
                open={openSessionId === session.id}
                session={session}
              />
            ))}
          </ul>
        ) : cursor === null ? (
          filtered ? (
            <Empty
              body="Log it in a workout and it shows up here."
              heading={`No sets for ${filteredName} yet`}
            />
          ) : (
            // Not an error and not styled like one: a client who has not finished a workout yet
            // has nothing to fix.
            <Empty body="Finish a workout and it shows up here." heading="Nothing logged yet" />
          )
        ) : (
          // Nothing to show and the feed is not exhausted: the screen is either reading on for a
          // session the boundary cut, or a continuation failed and the control below says so.
          // Either way "nothing logged yet" would be a lie, so nothing is claimed.
          null
        )}

        {load === 'ready' && cursor !== null && (
          <div className="mt-6 grid gap-2">
            {moreError !== null && (
              <Message id="history-more-error" tone="failure">
                {moreError}
              </Message>
            )}
            <button
              aria-describedby={moreError === null ? undefined : 'history-more-error'}
              className="min-h-[var(--tap-min)] w-full rounded-sm border border-edge bg-surface-sunk px-4 text-base font-semibold text-ink disabled:text-muted"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              type="button"
            >
              {loadingMore ? 'Loading' : moreError !== null ? 'Try again' : 'Load older workouts'}
            </button>
          </div>
        )}
      </div>
    </main>
  )
}

// A select rather than the tab strip Today uses to pick a day. A program has three or four days
// and they fit across a phone; the exercise list is every movement the client has ever logged
// and has no ceiling, so a horizontal strip would be a scroll inside a scroll. It is also a
// native control, which on a phone means the platform's own picker.
function ExerciseFilter({
  chosenId,
  onChoose,
  options,
}: {
  chosenId: string | null
  onChoose: (id: string | null) => void
  options: { id: string; name: string }[]
}) {
  return (
    <div className="mt-6 grid gap-2">
      <label className="text-sm font-semibold text-ink" htmlFor="history-exercise">
        Exercise
      </label>
      <select
        className="min-h-[var(--tap-min)] rounded-sm border border-edge bg-surface px-2 text-base text-ink"
        id="history-exercise"
        onChange={(event) => onChoose(event.target.value === '' ? null : event.target.value)}
        value={chosenId ?? ''}
      >
        <option value="">All exercises</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  )
}

// The card, and the tap target, are the same element: the whole summary opens the session,
// rather than a chevron sized either to dominate the card or to be missed on a gym floor. Same
// argument as the saved set row on the log screen, and the same shape — the detail opens
// below, so a second tap in the same place closes it rather than landing on something else.
function SessionCard({
  onToggle,
  open,
  session,
}: {
  onToggle: () => void
  open: boolean
  session: HistorySession
}) {
  const date = formatSessionDate(session.performedOn)
  const summary = `${count(session.exercises.length, 'exercise', 'exercises')} · ${count(session.setCount, 'set', 'sets')}`

  return (
    <li className="rounded-md border border-edge">
      {/* Heading wrapping the button: the accordion pattern, and it gives the list a real
          outline so a screen reader can move session to session. The label is spelled out
          because the visible summary leans on a separator glyph that does not read as a
          sentence. */}
      <h2>
        <button
          aria-expanded={open}
          aria-label={`${date}, ${count(session.exercises.length, 'exercise', 'exercises')}, ${count(session.setCount, 'set', 'sets')}`}
          className="grid w-full gap-1 p-4 text-left"
          onClick={onToggle}
          type="button"
        >
          <span className="text-base font-semibold text-ink-bold">{date}</span>
          <span className="text-sm text-muted">{summary}</span>
        </button>
      </h2>

      {open && (
        <div className="grid gap-6 border-t border-edge p-4">
          {/* Her note to the trainer (database.md: the v1 substitute for messaging). It reads
              in the detail rather than on the summary, so the collapsed list stays a column of
              dates and counts to scan rather than a wall of prose. */}
          {session.comment !== null && session.comment !== '' && (
            <p className="text-sm text-ink">{session.comment}</p>
          )}

          {session.exercises.map((exercise) => (
            <ExerciseSets exercise={exercise} key={exercise.id} />
          ))}
        </div>
      )}
    </li>
  )
}

// Recorded values, and nothing else. DESIGN.md's three-number hierarchy governs the log row,
// where today's inputs outrank last time which outranks the prescription; none of those roles
// exist here. So there is one rank: what she lifted, at --text-base / 600 / --ink-bold with
// tabular-nums so successive sets line up, and a set number in --muted to count them off.
function ExerciseSets({ exercise }: { exercise: HistoryExerciseGroup }) {
  return (
    <div className="grid gap-2">
      <h3 className="text-base font-semibold text-ink-bold">{exercise.name}</h3>
      <ul className="grid gap-1">
        {exercise.sets.map((set) => (
          // Labelled, with the cells hidden behind it, for the same reason the log screen's
          // saved row is: the columns are laid out by the grid and nothing separates them in
          // the text stream, so read cell by cell "1" and "100 × 5" run together into "1100".
          <li
            aria-label={spokenSet(set)}
            className="grid grid-cols-[2rem_1fr] items-baseline gap-3"
            key={set.id}
          >
            <span aria-hidden="true" className="text-sm text-muted tabular-nums">
              {set.setNumber}
            </span>
            <span aria-hidden="true" className="text-base font-semibold text-ink-bold tabular-nums">
              {set.weightKg === null ? (
                // Bodyweight (weight_kg NULL, database.md). Named rather than shown as
                // "– × 8", which reads as a number that went missing.
                `${set.reps} reps`
              ) : (
                <>
                  {set.weightKg}
                  <span className="text-muted"> × </span>
                  {set.reps}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Empty({ body, heading }: { body: string; heading: string }) {
  return (
    <div className="mt-8 grid gap-2">
      <h2 className="text-lg font-semibold text-ink-bold">{heading}</h2>
      <p className="text-base text-muted">{body}</p>
    </div>
  )
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mt-8 grid justify-items-start gap-4">
      <div className="grid gap-2">
        <h2 className="text-lg font-semibold text-ink-bold">We couldn&rsquo;t load your history</h2>
        <p className="text-base text-muted">Check your connection and try again.</p>
      </div>
      <button
        className="min-h-[var(--tap-min)] text-base font-semibold text-ink underline underline-offset-4"
        onClick={onRetry}
        type="button"
      >
        Try again
      </button>
    </div>
  )
}

// ui-ux.md asks for a skeleton on Today and History. Card-shaped, because that is what arrives.
// Static blocks, no shimmer: v1 has no motion vocabulary and an animated skeleton would be the
// only moving thing in the app.
function HistorySkeleton() {
  return (
    <div className="mt-6 grid gap-3" role="status">
      <span className="sr-only">Loading your history</span>
      {[0, 1, 2].map((card) => (
        <div className="grid gap-2 rounded-md border border-edge p-4" key={card}>
          <div className="h-5 w-40 rounded-sm bg-surface-sunk" />
          <div className="h-4 w-28 rounded-sm bg-surface-sunk" />
        </div>
      ))}
    </div>
  )
}

/** "Set 2, 102.5 kilograms by 5 reps". Same wording the log screen reads a saved row with. */
function spokenSet(set: { setNumber: number; weightKg: number | null; reps: number }): string {
  return set.weightKg === null
    ? `Set ${set.setNumber}, ${set.reps} reps`
    : `Set ${set.setNumber}, ${set.weightKg} kilograms by ${set.reps} reps`
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`
}

/** Adds any exercise this page introduced, keeping the list sorted and free of duplicates. */
function mergeOptions(
  previous: { id: string; name: string }[],
  items: HistoryItem[],
): { id: string; name: string }[] {
  const known = new Set(previous.map((option) => option.id))
  const added = exerciseOptions(items).filter((option) => !known.has(option.id))
  if (added.length === 0) {
    return previous
  }

  return [...previous, ...added].sort((left, right) => left.name.localeCompare(right.name))
}
