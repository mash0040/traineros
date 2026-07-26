import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import type {
  HistoryItem,
  MeProgramDetails,
  MeResponse,
  PrescriptionView,
} from '../api/types.gen'
import {
  ApiError,
  createSession,
  fetchHistory,
  fetchMyProgram,
  logSet,
  updateSessionComment,
} from '../lib/api'
import { targetLine } from '../lib/prescription'
import { clearDraft, readDraft, todayIn, writeDraft } from '../lib/workoutDraft'

type Load = 'loading' | 'ready' | 'unreachable'

/** A set the server has acknowledged. Nothing reaches this list without a 201. */
type SavedSet = { id: string; setNumber: number; weightKg: number | null; reps: number }

/**
 * A failed write, split by whether the request arrived.
 *
 * The distinction is the #42 lesson and it is not cosmetic: `unreachable` means the set may be
 * gone and tapping again is the right move, while `rejected` means the server understood and
 * refused, so tapping again unchanged will fail identically.
 */
type Failure = { kind: 'unreachable' | 'rejected'; message: string }

/**
 * The row currently being typed into. One per exercise, always present, never on the server.
 *
 * `dirty` separates what she entered from what the app suggested. The next row arrives
 * pre-filled from the last saved set (ui-ux.md), so "this row has numbers in it" is not
 * evidence of unsaved work — without the distinction, Finish would be blocked forever after
 * the first set by a row nobody touched.
 */
type Pending = {
  weight: string
  reps: string
  dirty: boolean
  saving: boolean
  failure: Failure | null
}

type Block = { saved: SavedSet[]; pending: Pending }

const EMPTY_PENDING: Pending = { weight: '', reps: '', dirty: false, saving: false, failure: null }

// ui-ux.md §Client screens, Log workout — "THE screen. Everything above binds here."
// Reached from Today's Start workout as /workout?day={program_day_id}.
//
// #47 built the container; #45 fills the set rows. The last-time column is #46 and is left
// alone. What changed from #47, and why, is below.
//
// ── When the session row is created ────────────────────────────────────────────────────────
// #47 created it at Finish, because that was the only moment the API would accept a comment and
// because a row that exists is a workout that happened. Neither holds now. logged_sets.session_id
// is non-null and sets cannot be buffered on the device (offline is a ui-ux.md non-goal), so the
// row has to exist before the first set is written; and #96 added PATCH /api/me/sessions/:id, so
// the comment no longer depends on creation timing.
//
// So creation moved into ensureSession(), called by the first set that needs somewhere to go.
// A session with zero sets is still never created: tapping Start and walking away writes nothing.
//
// ── Why that reopens the duplicate problem, and what closes it ─────────────────────────────
// Under #47 nothing existed until Finish, so leaving mid-workout could not duplicate anything.
// Now it can: log a set, lock the phone, come back to a fresh mount, and a naive screen creates
// a second row. workout_sessions has no unique constraint to catch it, so this screen is the
// only thing standing between one workout and two half-workouts in the history.
//
// Three guards, because they fail differently:
//   1. The draft record carries the session id, so a remount resumes the row instead of POSTing.
//   2. ensureSession de-duplicates concurrent callers through one shared promise — two exercises
//      saving their first set at the same moment must not race into two rows.
//   3. Resuming re-reads what is already logged (GET /api/me/history filtered to the session).
//      Without it the screen would restart set numbering at 1 and write duplicate set_numbers,
//      which the schema has no constraint against either.
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

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<Record<string, Block>>({})

  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)

  const performedOn = useMemo(() => todayIn(me.timezone), [me.timezone])

  // Guard 2. A ref, not state: two save handlers firing in the same tick must see the same
  // in-flight promise, and a state update would not have landed yet for the second one.
  const creating = useRef<Promise<string> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId

  // Loading and resuming are one operation. Splitting them let the persist effect fire between
  // the two and overwrite a real draft with the empty initial state.
  useEffect(() => {
    let cancelled = false
    setLoad('loading')

    async function boot() {
      const wrapper = await fetchMyProgram()
      const draft = readDraft(performedOn, dayId)

      // Guard 3. Only on a resume — a fresh workout has nothing to read back, and this is a
      // request on the critical path of opening the screen.
      let restored: Record<string, Block> = {}
      if (draft?.sessionId != null) {
        const history = await fetchHistory(HISTORY_PAGE)
        restored = rebuildBlocks(history.items ?? [], draft.sessionId, wrapper.program ?? null, dayId)
      }

      if (cancelled) {
        return
      }

      setProgram(wrapper.program ?? null)
      setSessionId(draft?.sessionId ?? null)
      sessionIdRef.current = draft?.sessionId ?? null
      setComment(draft?.comment ?? '')
      setBlocks(restored)
      setResumed(draft !== null && (draft.comment !== '' || draft.sessionId !== null))
      setHydrated(true)
      setLoad('ready')
    }

    boot().catch(() => {
      if (!cancelled) {
        // A failed restore is not a recoverable partial state: continuing would mean logging
        // against a session whose contents are unknown, which is how duplicate set numbers get
        // written. The screen refuses to render rather than guess.
        setLoad('unreachable')
      }
    })

    return () => {
      cancelled = true
    }
  }, [attempt, performedOn, dayId])

  // Comment save timing, unchanged from #47 and deliberately not a PATCH per keystroke: that
  // would be a request storm on a phone for no benefit. Keystrokes go to the device, and the
  // one network write happens at Finish (#96's PATCH).
  useEffect(() => {
    if (!hydrated) {
      return
    }

    if (comment === '' && sessionId === null) {
      clearDraft()
      return
    }

    writeDraft({ performedOn, programDayId: dayId, comment, sessionId })
  }, [comment, sessionId, hydrated, performedOn, dayId])

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionIdRef.current !== null) {
      return sessionIdRef.current
    }

    if (creating.current !== null) {
      return creating.current
    }

    const inFlight = (async () => {
      const created = await createSession({ performedOn, programDayId: dayId, comment: null })
      if (created.id === undefined) {
        throw new ApiError(0, 'unknown', 'Something went wrong. Try again.')
      }

      // Persisted before the state update, and by merging onto what is already stored rather
      // than onto a captured value: the comment is written on every keystroke, so re-reading it
      // is the only way to avoid clobbering a note typed while this request was in flight.
      const existing = readDraft(performedOn, dayId)
      writeDraft({
        performedOn,
        programDayId: dayId,
        comment: existing?.comment ?? '',
        sessionId: created.id,
      })

      sessionIdRef.current = created.id
      setSessionId(created.id)
      return created.id
    })()

    creating.current = inFlight
    try {
      return await inFlight
    } catch (caught) {
      // Cleared so a retry can try again. Left set, one failed creation would wedge every
      // subsequent set on this screen behind a permanently rejected promise.
      creating.current = null
      throw caught
    }
  }, [performedOn, dayId])

  const days = program?.days ?? []
  const day = days.find((candidate) => candidate.id === dayId) ?? null
  const prescriptions = day?.prescriptions ?? []

  function blockFor(prescriptionId: string): Block {
    return blocks[prescriptionId] ?? { saved: [], pending: EMPTY_PENDING }
  }

  function updatePending(prescriptionId: string, patch: Partial<Pending>) {
    setBlocks((previous) => {
      const block = previous[prescriptionId] ?? { saved: [], pending: EMPTY_PENDING }
      return { ...previous, [prescriptionId]: { ...block, pending: { ...block.pending, ...patch } } }
    })
  }

  async function onSaveSet(prescription: PrescriptionView) {
    const key = prescription.id
    const exerciseId = prescription.exercise?.id
    if (key === undefined || exerciseId === undefined) {
      return
    }

    const block = blockFor(key)
    if (block.pending.saving) {
      return
    }

    // Validated here rather than at the server, so a missing rep count costs no round trip on
    // gym wifi. Both checks mirror the endpoint's own, and both surface as `rejected` because
    // that is what they are.
    const reps = Number.parseInt(block.pending.reps.trim(), 10)
    if (!Number.isInteger(reps) || reps <= 0) {
      updatePending(key, { failure: { kind: 'rejected', message: 'Enter how many reps you did.' } })
      return
    }

    const weightText = block.pending.weight.trim()
    const weightKg = weightText === '' ? null : Number(weightText)
    if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 0)) {
      updatePending(key, { failure: { kind: 'rejected', message: 'Weight must be a number, or empty for bodyweight.' } })
      return
    }

    updatePending(key, { saving: true, failure: null })

    try {
      const targetSession = await ensureSession()
      const saved = await logSet(targetSession, {
        exerciseId,
        programDayExerciseId: key,
        setNumber: block.saved.length + 1,
        weightKg,
        reps,
      })

      setBlocks((previous) => {
        const current = previous[key] ?? { saved: [], pending: EMPTY_PENDING }
        const row: SavedSet = {
          id: saved.id ?? crypto.randomUUID(),
          setNumber: saved.setNumber ?? current.saved.length + 1,
          weightKg: saved.weightKg ?? null,
          reps: saved.reps ?? reps,
        }
        return {
          ...previous,
          // ui-ux.md: the next set pre-fills from this one, because most sets repeat the weight
          // and editing is the exception path.
          [key]: { saved: [...current.saved, row], pending: prefillFrom(row) },
        }
      })
    } catch (caught) {
      // The typed values stay exactly where they are. Losing them here is the failure mode that
      // matters: she believes it saved, it did not, and she finds out never.
      updatePending(key, { saving: false, failure: classify(caught) })
    }
  }

  async function onFinish() {
    if (finishing) {
      return
    }

    // Nothing is written implicitly at Finish. A typed-but-unsaved row is the one place this
    // screen could still lose a set silently, so it blocks and says which exercise instead.
    const unsaved = prescriptions.filter((prescription) => {
      const pending = blockFor(prescription.id ?? '').pending
      // Only what she typed. A pre-filled row she never touched is a suggestion, and clearing
      // a row she did touch leaves nothing to lose.
      return pending.dirty && (pending.weight.trim() !== '' || pending.reps.trim() !== '')
    })
    if (unsaved.length > 0) {
      const names = unsaved.map((prescription) => prescription.exercise?.name ?? 'an exercise')
      setFinishError(`Save or clear the set you started on ${listNames(names)} first.`)
      return
    }

    setFinishing(true)
    setFinishError(null)

    const trimmed = comment.trim()
    try {
      if (sessionId !== null) {
        // The row exists because sets were logged, so the note goes on with #96's PATCH. Skipped
        // when there is no note: the column is already null and a request to confirm that is
        // one more thing to fail on a bad connection.
        if (trimmed !== '') {
          await updateSessionComment(sessionId, trimmed)
        }
      } else if (trimmed !== '') {
        // A note but no sets. The row does not exist yet and POST takes a comment directly, so
        // this is one request rather than a create followed by a patch.
        await createSession({ performedOn, programDayId: dayId, comment: trimmed })
      }

      clearDraft()
      navigate('/', { replace: true })
    } catch (caught) {
      setFinishError(classify(caught).message)
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
        <p className="mt-8 text-base text-muted">There&rsquo;s nothing prescribed for this day.</p>
      ) : (
        <ul className="mt-8 grid gap-6">
          {prescriptions.map((prescription) => (
            <ExerciseBlock
              block={blockFor(prescription.id ?? '')}
              key={prescription.id}
              onChangeReps={(reps) => updatePending(prescription.id ?? '', { reps, dirty: true, failure: null })}
              onChangeWeight={(weight) =>
                updatePending(prescription.id ?? '', { weight, dirty: true, failure: null })
              }
              onSave={() => void onSaveSet(prescription)}
              prescription={prescription}
            />
          ))}
        </ul>
      )}

      <SessionComment onChange={setComment} resumed={resumed} value={comment} />

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
            onClick={() => void onFinish()}
            type="button"
          >
            {finishing ? 'Saving' : 'Finish workout'}
          </button>
        </div>
      </div>
    </Shell>
  )
}

/**
 * How many recent sets to read when resuming.
 *
 * The API caps limit at 100 and a single workout is nowhere near that, so one page always
 * covers the session being resumed. Sets from earlier sessions come back too and are filtered
 * out by session id — the endpoint has no session filter, and adding one is not this ticket.
 */
const HISTORY_PAGE = 100

// DESIGN.md §Log row, row order left-to-right on mobile:
//
//     [set #]  [last-time]  [weight input]  [reps input]
//
// Unchanged from #47. #46 still owns the last-time column; the two input columns are #45's.
// The first two columns are fixed and the inputs share the remainder, because the numbers on
// the left are read and the controls on the right are tapped.
const LOG_ROW_GRID = 'grid grid-cols-[2rem_5rem_1fr_1fr] items-end gap-3'

function ExerciseBlock({
  block,
  onChangeReps,
  onChangeWeight,
  onSave,
  prescription,
}: {
  block: Block
  onChangeReps: (value: string) => void
  onChangeWeight: (value: string) => void
  onSave: () => void
  prescription: PrescriptionView
}) {
  const exercise = prescription.exercise
  const name = exercise?.name ?? 'Exercise'
  const target = targetLine(prescription)
  const nextSetNumber = block.saved.length + 1

  return (
    // Labelled so the whole block is announced as a unit, and so a test can scope to one
    // exercise when every block carries identically-worded controls.
    <li aria-label={name} className="rounded-md border border-edge p-4">
      <h2 className="text-base font-semibold text-ink-bold">{name}</h2>

      {/* Rank 3 (DESIGN.md §Log row): the prescription reads once, in the block header, in
          --text-sm / 400 / --muted. Never bolded, never repeated per set row. */}
      {target !== '' && <p className="mt-1 text-sm text-muted">{target}</p>}

      {prescription.note !== null && prescription.note !== undefined && prescription.note !== '' && (
        <p className="mt-1 text-sm text-ink">{prescription.note}</p>
      )}

      <div className="mt-4 grid gap-3 border-t border-edge pt-4">
        {block.saved.map((set) => (
          <SavedRow key={set.id} set={set} />
        ))}

        <div className={LOG_ROW_GRID}>
          <span className="pb-2 text-sm text-muted tabular-nums">{nextSetNumber}</span>

          {/* Rank 2, #46's column. The `Last` label with a single dash is the empty state
              DESIGN.md specifies; the numbers that replace the dash are that ticket's. */}
          <LastCell />

          <NumberField
            inputMode="decimal"
            label="kg"
            name={`${name} set ${nextSetNumber} weight in kilograms`}
            onChange={onChangeWeight}
            value={block.pending.weight}
          />
          <NumberField
            inputMode="numeric"
            label="Reps"
            name={`${name} set ${nextSetNumber} reps`}
            onChange={onChangeReps}
            value={block.pending.reps}
          />
        </div>

        {block.pending.failure !== null && (
          <p className="text-sm text-danger" role="alert">
            {block.pending.failure.message}
          </p>
        )}

        {/* Full-width and 44px: the second-most-tapped control on the screen, and the one that
            has to be hittable without looking. Its label carries the failure state, because
            "Try again" and "Save set" are different promises. */}
        <button
          className="grid min-h-[var(--tap-min)] w-full place-items-center rounded-sm border border-edge bg-surface-sunk px-4 text-base font-semibold text-ink disabled:text-muted"
          disabled={block.pending.saving}
          onClick={onSave}
          type="button"
        >
          {block.pending.saving ? 'Saving' : block.pending.failure !== null ? 'Try again' : 'Save set'}
        </button>
      </div>
    </li>
  )
}

// A set the server has: static numbers, same columns, same weight treatment (DESIGN.md gives
// the value in a completed set row 600). Turning back into plain text is the confirmation —
// there is no motion vocabulary in v1 and a toast per set would be intolerable at 20 sets.
function SavedRow({ set }: { set: SavedSet }) {
  return (
    <div className={LOG_ROW_GRID}>
      <span className="text-sm text-muted tabular-nums">{set.setNumber}</span>
      <LastCell />
      <span className="text-right text-lg font-semibold text-ink-bold tabular-nums">
        {set.weightKg === null ? '—' : set.weightKg}
      </span>
      <span className="text-right text-lg font-semibold text-ink-bold tabular-nums">{set.reps}</span>
    </div>
  )
}

function LastCell() {
  return (
    <span className="grid gap-1">
      <span className="text-xs text-muted">Last</span>
      <span className="text-base font-semibold text-muted tabular-nums">&ndash;</span>
    </span>
  )
}

// Rank 1 (DESIGN.md §Log row): --text-lg / 600 / --ink-bold, tabular-nums, digits right-aligned,
// 44px minimum. inputMode per ui-ux.md — a full keyboard for a number is a gym-floor failure.
//
// type="text" with an inputMode rather than type="number": number inputs scroll-wheel their own
// value, reject a locale's decimal comma, and put spinners inside a 44px target.
function NumberField({
  inputMode,
  label,
  name,
  onChange,
  value,
}: {
  inputMode: 'decimal' | 'numeric'
  label: string
  name: string
  onChange: (value: string) => void
  value: string
}) {
  return (
    <span className="grid gap-1">
      <span aria-hidden="true" className="text-xs text-muted">
        {label}
      </span>
      <input
        aria-label={name}
        autoComplete="off"
        className="min-h-[var(--tap-min)] w-full rounded-sm border border-edge bg-surface px-2 text-right text-lg font-semibold text-ink-bold tabular-nums"
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        type="text"
        value={value}
      />
    </span>
  )
}

// database.md: "the client's note to trainer ('shoulder tweaked on OHP'). This is the v1
// substitute for messaging." Which is why it is a plain labelled textarea in the flow of the
// workout rather than something behind a tap — the one channel she has.
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
      {resumed && <p className="text-sm text-muted">Picking up where you left off.</p>}
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

function prefillFrom(set: SavedSet): Pending {
  return {
    weight: set.weightKg === null ? '' : String(set.weightKg),
    reps: String(set.reps),
    // Suggested, not entered. See Pending.
    dirty: false,
    saving: false,
    failure: null,
  }
}

/**
 * Which sets this session already has, read back from history.
 *
 * Matched by exercise id, because history does not return program_day_exercise_id. A day that
 * prescribes the same exercise twice therefore attaches all of its sets to the first of the two
 * — rare enough to accept at v1 scale, and the alternative is a new endpoint.
 */
function rebuildBlocks(
  items: HistoryItem[],
  sessionId: string,
  program: MeProgramDetails | null,
  dayId: string | null,
): Record<string, Block> {
  const byExercise = new Map<string, SavedSet[]>()
  for (const item of items) {
    if (item.session?.id !== sessionId || item.exercise?.id === undefined) {
      continue
    }

    const list = byExercise.get(item.exercise.id) ?? []
    list.push({
      id: item.id ?? crypto.randomUUID(),
      setNumber: item.setNumber ?? list.length + 1,
      weightKg: item.weightKg ?? null,
      reps: item.reps ?? 0,
    })
    byExercise.set(item.exercise.id, list)
  }

  const day = (program?.days ?? []).find((candidate) => candidate.id === dayId)
  const blocks: Record<string, Block> = {}
  const claimed = new Set<string>()

  for (const prescription of day?.prescriptions ?? []) {
    const exerciseId = prescription.exercise?.id
    if (prescription.id === undefined || exerciseId === undefined || claimed.has(exerciseId)) {
      continue
    }

    const saved = byExercise.get(exerciseId)
    if (saved === undefined || saved.length === 0) {
      continue
    }

    claimed.add(exerciseId)
    // History comes back newest-first; the row order here is the set order.
    saved.sort((left, right) => left.setNumber - right.setNumber)
    blocks[prescription.id] = { saved, pending: prefillFrom(saved[saved.length - 1]) }
  }

  return blocks
}

function classify(caught: unknown): Failure {
  if (caught instanceof ApiError && caught.status === 0) {
    // status 0 is api.ts's marker for "fetch itself threw" — offline, DNS, refused connection.
    // Nothing reached the server, so the same tap is worth making again.
    return { kind: 'unreachable', message: 'No connection. Nothing was saved — try again.' }
  }

  if (caught instanceof ApiError) {
    // The server answered and refused. Its message is written for the person reading it
    // (api.md keeps them human), so it is shown rather than replaced with a generic line.
    return { kind: 'rejected', message: caught.message }
  }

  return { kind: 'rejected', message: 'Something went wrong. Try again.' }
}

function listNames(names: string[]): string {
  if (names.length === 1) {
    return names[0]
  }

  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
