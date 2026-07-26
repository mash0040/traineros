import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import type { MeProgramDetails, MeResponse, PrescriptionView } from '../api/types.gen'
import { ApiError, createSession, fetchMyProgram } from '../lib/api'
import { targetLine } from '../lib/prescription'
import { clearDraft, readDraft, todayIn, writeDraft } from '../lib/workoutDraft'

type Load = 'loading' | 'ready' | 'unreachable'

// ui-ux.md §Client screens, Log workout — "THE screen. Everything above binds here."
// Reached from Today's Start workout as /workout?day={program_day_id}.
//
// #47 is the container: the session's lifecycle, the day's exercises, the comment, finishing.
// Set logging is #45 and inline last-time is #46; both land inside ExerciseBlock, against the
// column template LOG_ROW_GRID already defines.
//
// ── Decision 1: what "finish" means ────────────────────────────────────────────────────────
// The ticket's premise was that the row exists from the moment the workout starts, which would
// make finishing pure navigation. Inverted here: the row is created *by* finishing.
//
// Two facts force it. database.md gives workout_sessions no status and no completed_at, so the
// existence of the row is the only record that a gym visit happened — creating one when the
// client taps Start would write a workout for every tap that got interrupted before a single
// rep, and the trainer's history (GET /api/clients/:id/sessions) is where those phantoms would
// surface. And api.md accepts `comment` only in the POST body, with no PATCH for a session, so
// creation is the one moment at which the comment field can persist at all.
//
// So the row means what the schema says it means, and finishing is a real write rather than a
// state change on a row that has none to change.
//
// ── Decision 2: navigating away mid-session ────────────────────────────────────────────────
// Because nothing is written until Finish, leaving mid-session creates no row, and coming back
// therefore cannot create a second one. The duplicate the schema has no unique constraint
// against is not prevented here so much as never reachable. What has to survive the phone lock
// is the comment, which does: it is written to the device on every keystroke and read back on
// mount, keyed by (performed_on, program_day_id) so it only ever restores into the workout it
// was typed in.
//
// This is exactly as durable as the device. A different phone, or the same phone with storage
// cleared, starts empty — acceptable, because nothing has been lost that the server ever knew.
//
// ── What #45 changes about both ────────────────────────────────────────────────────────────
// Logged sets are ground truth and have to reach the server as they happen (buffering them
// locally is offline behaviour, a ui-ux.md non-goal), so #45 needs a session id before Finish
// and will create the row on the first set instead. At that point:
//   * duplicates become reachable again. The fix is already scaffolded: put the returned id in
//     the draft record, and have #45 resume that id instead of POSTing when one is present for
//     today's (performed_on, program_day_id).
//   * the comment gap opens. A row created at the first set cannot accept a comment typed
//     afterwards, and no PATCH /api/me/sessions/:id exists. #45 is blocked on adding one; that
//     is an api.md change and out of #47's scope.
export function LogWorkoutScreen({ me }: { me: MeResponse }) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const dayId = searchParams.get('day')

  const [load, setLoad] = useState<Load>('loading')
  const [program, setProgram] = useState<MeProgramDetails | null>(null)
  const [attempt, setAttempt] = useState(0)

  const [comment, setComment] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const [resumed, setResumed] = useState(false)

  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)

  const performedOn = useMemo(() => todayIn(me.timezone), [me.timezone])

  useEffect(() => {
    let cancelled = false
    setLoad('loading')

    fetchMyProgram()
      .then((wrapper) => {
        if (!cancelled) {
          setProgram(wrapper.program ?? null)
          setLoad('ready')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoad('unreachable')
        }
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  // Restore before the first write, never after: the persist effect below would otherwise
  // overwrite a real draft with the empty initial state on mount.
  useEffect(() => {
    const draft = readDraft(performedOn, dayId)
    setComment(draft?.comment ?? '')
    setResumed(draft !== null && draft.comment !== '')
    setHydrated(true)
  }, [performedOn, dayId])

  // Comment save timing, stated because both obvious answers are wrong: a debounced PATCH per
  // keystroke would hammer an endpoint that does not exist, and saving only at Finish loses
  // the note to a closed tab. So the keystroke write goes to the device and the network write
  // happens once. localStorage.setItem is synchronous and this is a few hundred bytes, so
  // there is nothing here worth debouncing — the cost being avoided was always the request.
  useEffect(() => {
    if (!hydrated) {
      return
    }

    if (comment === '') {
      clearDraft()
      return
    }

    writeDraft({ performedOn, programDayId: dayId, comment })
  }, [comment, hydrated, performedOn, dayId])

  const days = program?.days ?? []
  const day = days.find((candidate) => candidate.id === dayId) ?? null
  const prescriptions = day?.prescriptions ?? []

  async function onFinish() {
    // Guarded twice on purpose. `disabled` is what actually stops the gym-floor double tap,
    // and this stops the write itself — a button that moves or gains a keyboard path in a
    // later ticket should not be able to take the idempotency with it.
    // Guarded twice on purpose. `disabled` is what actually stops the gym-floor double tap,
    // and this stops the write itself — a button that moves or gains a keyboard path in a
    // later ticket should not be able to take the idempotency with it.
    if (finishing) {
      return
    }

    setFinishing(true)
    setFinishError(null)

    const trimmed = comment.trim()
    try {
      await createSession({
        performedOn,
        programDayId: dayId,
        comment: trimmed === '' ? null : trimmed,
      })

      // Only after the server has the row. A failed finish leaves the draft alone so the note
      // is still there to retry with.
      clearDraft()
      // replace: Finish is terminal, and Back from Today should not return to a workout that
      // has already been written.
      navigate('/', { replace: true })
    } catch (caught) {
      setFinishError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
      setFinishing(false)
    }
  }

  if (load === 'loading') {
    return (
      <Shell>
        <p className="mt-8 text-base text-muted" role="status">
          Loading your workout
        </p>
      </Shell>
    )
  }

  if (load === 'unreachable') {
    return (
      <Shell>
        <Problem
          heading="We couldn&rsquo;t load your workout"
          body="Check your connection and try again."
          action={
            <button
              className="min-h-[var(--tap-min)] text-base font-semibold text-ink underline underline-offset-4"
              onClick={() => setAttempt((previous) => previous + 1)}
              type="button"
            >
              Try again
            </button>
          }
        />
      </Shell>
    )
  }

  // No day, or a day that is not in the active program: a stale bookmark, or a program the
  // trainer rebuilt since. Not an error to apologise for, and not a freestyle session either —
  // program_day_id may be null in the schema, but nothing in v1 offers a way to start one, and
  // inventing that entry point here would be scope this ticket does not have.
  if (day === null) {
    return (
      <Shell>
        <Problem
          heading="That workout isn&rsquo;t in your program"
          body="Your trainer may have changed it. Pick a day to start from."
          action={
            <Link
              className="min-h-[var(--tap-min)] text-base font-semibold text-ink underline underline-offset-4"
              to="/"
            >
              Back to today
            </Link>
          }
        />
      </Shell>
    )
  }

  return (
    <Shell>
      <h1 className="mt-8 text-xl font-semibold text-ink-bold">{day.title}</h1>
      {program !== null && <p className="mt-1 text-sm text-muted">{program.title}</p>}

      {prescriptions.length === 0 ? (
        <p className="mt-8 text-base text-muted">
          There&rsquo;s nothing prescribed for this day.
        </p>
      ) : (
        // DESIGN.md §Cards permits a card here and nowhere near it: an exercise block owns its
        // own inputs and is genuinely one object. Between exercises is the generous end of the
        // spacing scale (24–32px) so a thumb scrolling mid-set lands on a whole block.
        <ul className="mt-8 grid gap-6">
          {prescriptions.map((prescription) => (
            <ExerciseBlock key={prescription.id} prescription={prescription} />
          ))}
        </ul>
      )}

      <SessionComment onChange={setComment} resumed={resumed} value={comment} />

      {/* Sticky, shadowed, thumb-reachable — the one elevation DESIGN.md allows, for the one
          CTA on the screen. Disable-on-tap per ui-ux.md: this POST creates a row and has no
          idempotency key, so a double tap is a duplicate workout. */}
      <div className="sticky bottom-0 -mx-6 mt-10 border-t border-edge bg-surface px-6 pb-8 pt-4 shadow-[var(--shadow-sticky)]">
        <div className="mx-auto grid w-full max-w-lg gap-2">
          {finishError !== null && (
            <p className="text-sm text-danger" id="finish-error" role="alert">
              {finishError}
            </p>
          )}
          <button
            aria-describedby={finishError === null ? undefined : 'finish-error'}
            className="grid min-h-[var(--tap-min)] w-full place-items-center rounded-md bg-accent px-4 text-base font-semibold text-accent-ink hover:bg-accent-hover disabled:bg-surface-sunk disabled:text-muted"
            disabled={finishing}
            onClick={onFinish}
            type="button"
          >
            {finishing ? 'Saving' : 'Finish workout'}
          </button>
        </div>
      </div>
    </Shell>
  )
}

// DESIGN.md §Log row, row order left-to-right on mobile:
//
//     [set #]  [last-time]  [weight input]  [reps input]
//
// #45 fills the weight and reps columns, #46 fills last-time. The template is a single
// constant so those two tickets inherit the order rather than each re-deriving it — the doc
// calls any change to it a design decision, not a component tweak. The first two columns are
// fixed and the inputs share the remainder, because the numbers on the left are read and the
// controls on the right are tapped, and only the tap targets should grow with the viewport.
const LOG_ROW_GRID = 'grid grid-cols-[2rem_5rem_1fr_1fr] items-end gap-3'

function ExerciseBlock({ prescription }: { prescription: PrescriptionView }) {
  const exercise = prescription.exercise
  const target = targetLine(prescription)

  return (
    <li className="rounded-md border border-edge p-4">
      <h2 className="text-base font-semibold text-ink-bold">{exercise?.name}</h2>

      {/* Rank 3 (DESIGN.md §Log row): the prescription reads once, here in the block header,
          in --text-sm / 400 / --muted. Never bolded, never repeated per set row. */}
      {target !== '' && <p className="mt-1 text-sm text-muted">{target}</p>}

      {prescription.note !== null && prescription.note !== undefined && prescription.note !== '' && (
        <p className="mt-1 text-sm text-ink">{prescription.note}</p>
      )}

      {/* ── Placeholder: #45 (set rows, add-set) and #46 (last-time) ──────────────────────
          Everything below this comment down to the closing div is scaffold. It renders the
          column template with the two ranks that already have a specified empty state, so the
          two tickets replace cells rather than lay out a row.

          #46 replaces the em dash in the last-time cell with `72.5 × 8` — --text-base / 600 /
          --ink / tabular-nums, with the × in --muted, keeping the `Last` label above it.
          #45 replaces the weight and reps cells with inputs — --text-lg / 600 / --ink-bold /
          tabular-nums, min-height var(--tap-min), right-aligned digits, inputmode decimal and
          numeric respectively — fills the set-number cell per row, and adds the add-set
          control below.

          Inert text, not disabled inputs: a control that looks tappable and does nothing is
          worse on a gym floor than an honest gap. */}
      <div className="mt-4 border-t border-edge pt-4">
        <div className={LOG_ROW_GRID}>
          <span aria-hidden="true" className="text-sm text-muted tabular-nums">
            1
          </span>
          <span className="grid gap-1">
            <span className="text-xs text-muted">Last</span>
            <span className="text-base font-semibold text-muted tabular-nums">&ndash;</span>
          </span>
          <span className="grid gap-1">
            <span className="text-xs text-muted">kg</span>
            <span className="text-lg font-semibold text-muted tabular-nums">&ndash;</span>
          </span>
          <span className="grid gap-1">
            <span className="text-xs text-muted">Reps</span>
            <span className="text-lg font-semibold text-muted tabular-nums">&ndash;</span>
          </span>
        </div>
        <p className="mt-3 text-sm text-muted">Set logging arrives here.</p>
      </div>
    </li>
  )
}

// database.md: "the client's note to trainer ('shoulder tweaked on OHP'). This is the v1
// substitute for messaging." Which is why it is a plain labelled textarea sitting in the flow
// of the workout rather than something behind a tap — the one channel she has.
function SessionComment({
  onChange,
  resumed,
  value,
}: {
  onChange: (next: string) => void
  resumed: boolean
  value: string
}) {
  return (
    <div className="mt-12 grid gap-2">
      <label className="text-sm font-semibold text-ink" htmlFor="session-comment">
        Note for your trainer
      </label>
      <textarea
        className="min-h-[calc(var(--tap-min)*2)] rounded-sm border border-edge bg-surface p-3 text-base text-ink placeholder:text-muted"
        id="session-comment"
        name="comment"
        onChange={(event) => onChange(event.target.value)}
        placeholder="Anything they should know?"
        value={value}
      />
      {/* Shown only on a real resume. It is the single piece of evidence the client gets that
          leaving mid-workout was safe, and saying it unconditionally would make it noise. */}
      {resumed && <p className="text-sm text-muted">Your note from earlier is still here.</p>}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col px-6 pt-10">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col">{children}</div>
    </main>
  )
}

function Problem({
  action,
  body,
  heading,
}: {
  action: React.ReactNode
  body: string
  heading: string
}) {
  return (
    <div className="mt-8 grid justify-items-start gap-4">
      <div className="grid gap-2">
        <h1 className="text-lg font-semibold text-ink-bold">{heading}</h1>
        <p className="text-base text-muted">{body}</p>
      </div>
      {action}
    </div>
  )
}
