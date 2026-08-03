import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import type {
  HistoryItem,
  LastSet,
  MeProgramDetails,
  MeResponse,
  PrescriptionView,
} from '../api/types.gen'
import {
  ApiError,
  createSession,
  deleteSet,
  fetchHistory,
  fetchLastForExercise,
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

/**
 * What ensureSession hands back.
 *
 * `restored` is non-null only when the server resumed a row that already held sets, and it
 * carries them so the caller can number its next set from what is really there rather than from
 * the state it captured before asking.
 */
type EnsuredSession = { id: string; restored: Record<string, Block> | null }

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

  // Keyed by exercise id. Absent means still in flight, null means nothing to show — both
  // render the same dash, which is why the screen never waits on them.
  const [lastTimes, setLastTimes] = useState<Record<string, LastSet[] | null>>({})

  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)
  const [discardAsked, setDiscardAsked] = useState(false)

  const performedOn = useMemo(() => todayIn(me.timezone), [me.timezone])

  // Guard 2. A ref, not state: two save handlers firing in the same tick must see the same
  // in-flight promise, and a state update would not have landed yet for the second one.
  const creating = useRef<Promise<EnsuredSession> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId

  // ensureSession needs the program to map restored sets back onto prescriptions, but must not
  // be rebuilt when it changes — a new callback identity mid-flight would not share `creating`.
  const programRef = useRef<MeProgramDetails | null>(null)
  programRef.current = program

  // Loading and resuming are one operation. Splitting them let the persist effect fire between
  // the two and overwrite a real draft with the empty initial state.
  useEffect(() => {
    let cancelled = false
    setLoad('loading')

    async function boot() {
      // Fired together: the day comes from the program, today's session from history. Serialised
      // they would add a round trip to every screen open, and both are needed before the first
      // row can be numbered.
      const [wrapper, history] = await Promise.all([
        fetchMyProgram(),
        // Non-fatal on its own. If there turns out to be no session, nothing was lost; if there
        // is one, ensureSession's read-back still catches it at the first save. The mount-time
        // restore is an optimisation over that path, not a replacement for it.
        fetchHistory(HISTORY_PAGE).catch(() => null),
      ])

      const draft = readDraft(performedOn, dayId)

      // A draft naming a session is proof the row exists. Not being able to read what is in it
      // means logging blind into it, which is how duplicate set numbers get written — so that
      // case stays fatal rather than falling through to an empty screen.
      if (draft?.sessionId != null && history === null) {
        throw new ApiError(0, 'network', 'Something went wrong. Try again.')
      }

      const items = history?.items ?? []

      // #102: history's session summary now carries program_day_id, so today's session for this
      // day is identifiable from a read. Before that, POST /api/me/sessions was the only route
      // that resolved the triple, which is why the restore could not happen until the first save
      // — and why, until it did, the screen had no session id for #46's self-session filter to
      // compare against and showed her own earlier sets from today under the Last header.
      const resumedSession = draft?.sessionId ?? findSessionForDay(items, performedOn, dayId)

      const restored =
        resumedSession === null
          ? {}
          : rebuildBlocks(items, resumedSession, wrapper.program ?? null, dayId)

      // The note already on the row, when there is no local draft to prefer. Without it a client
      // reopening a finished day sees an empty box, and anything she types there replaces a note
      // she was never shown.
      const storedComment =
        items.find((item) => item.session?.id === resumedSession)?.session?.comment ?? ''

      if (cancelled) {
        return
      }

      setProgram(wrapper.program ?? null)
      setSessionId(resumedSession)
      sessionIdRef.current = resumedSession
      setComment(draft?.comment ?? storedComment)
      setBlocks(restored)
      setResumed(resumedSession !== null || (draft !== null && draft.comment !== ''))
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

  // Last-time (#46). Fired after the screen is already on the page, one request per distinct
  // exercise, all in parallel and none of them blocking anything.
  //
  // How this is fetched, decided (#46): there is no batch endpoint, so eight exercises is eight
  // requests. Two things make that acceptable and one makes it invisible.
  //   * They are parallel, so the wall clock is one round trip plus server time, not eight. Each
  //     is index-served (logged_sets on exercise_id, logged_at — database.md §Indexing).
  //   * They are deduplicated by exercise, not per prescription: a day that prescribes the same
  //     exercise twice still asks once.
  //   * The screen does not wait for any of them. The day, the targets, and the inputs render
  //     from the program alone; last-time cells start on the dash DESIGN.md specifies for the
  //     empty state and fill in as answers land. So the cost of eight requests is never paid in
  //     time-to-usable — she can log her first set before any of them return.
  // The honest cost is server-side: eight queries per screen open instead of one. At v1 scale
  // (one trainer, a handful of clients) that is not worth an endpoint. If it ever is, the fix is
  // a batch route taking exercise_ids, and this effect becomes one call.
  useEffect(() => {
    if (load !== 'ready') {
      return
    }

    const chosen = (program?.days ?? []).find((candidate) => candidate.id === dayId)
    const exerciseIds = [
      ...new Set(
        (chosen?.prescriptions ?? [])
          .map((prescription) => prescription.exercise?.id)
          .filter((id): id is string => id !== undefined),
      ),
    ]

    let cancelled = false
    for (const exerciseId of exerciseIds) {
      // One silent retry, then the dash. A dropped read of decision support is not worth an
      // error message on a screen whose job is logging.
      fetchLastForExercise(exerciseId)
        .catch(() => fetchLastForExercise(exerciseId))
        .then((response) => {
          if (cancelled) {
            return
          }

          const recent = response.mostRecent
          // Today's own work is not "last time". Since #45 the row is created by the first
          // logged set and #98 resumes it, so on a resumed session /api/me/last answers with
          // this very session for anything already logged today — and those sets are visible
          // in the rows directly above. Showing them again under a `Last` label would be a
          // second, wronger copy of what she is looking at.
          const isThisSession = recent?.sessionId !== undefined && recent.sessionId === sessionIdRef.current
          setLastTimes((previous) => ({
            ...previous,
            [exerciseId]: recent == null || isThisSession ? null : (recent.sets ?? null),
          }))
        })
        .catch(() => {
          if (!cancelled) {
            setLastTimes((previous) => ({ ...previous, [exerciseId]: null }))
          }
        })
    }

    return () => {
      cancelled = true
    }
  }, [load, program, dayId])

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

  const ensureSession = useCallback(async (): Promise<EnsuredSession> => {
    if (sessionIdRef.current !== null) {
      return { id: sessionIdRef.current, restored: null }
    }

    if (creating.current !== null) {
      return creating.current
    }

    const inFlight = (async (): Promise<EnsuredSession> => {
      const { session, resumed } = await createSession({
        performedOn,
        programDayId: dayId,
        comment: null,
      })
      if (session.id === undefined) {
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
        sessionId: session.id,
      })

      sessionIdRef.current = session.id
      setSessionId(session.id)

      // The second half of guard 3, and the seam the set-numbering bug came through.
      //
      // Guard 3 on mount only fires when a draft carried a session id, and Finish clears the
      // draft. So a client who finishes and reopens the same day has no draft, the screen
      // believes the block is empty, #98 hands back the row she already filled, and numbering
      // restarts at 1 — logged_sets has no unique constraint on (session_id, exercise_id,
      // set_number), so the database takes every duplicate.
      //
      // Restoring on mount is not available: identifying today's session for this program day
      // needs a lookup the API does not offer (history's session summary carries no
      // program_day_id, and POST is the only route that resolves the triple). So the read-back
      // happens here, at the first moment the screen learns the row already existed.
      if (!resumed) {
        return { id: session.id, restored: null }
      }

      const history = await fetchHistory(HISTORY_PAGE)
      const restored = rebuildBlocks(history.items ?? [], session.id, programRef.current, dayId)

      setBlocks((previous) => {
        const merged = { ...previous }
        for (const [prescriptionId, block] of Object.entries(restored)) {
          merged[prescriptionId] = {
            saved: block.saved,
            // Her half-typed row survives the rebuild. She is mid-save on one of these right
            // now; replacing it with a pre-fill would retype the set being written.
            pending: previous[prescriptionId]?.pending ?? block.pending,
          }
        }
        return merged
      })

      return { id: session.id, restored }
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

  // Exercises with a set she typed and never saved — the one place a set could still vanish
  // silently at Finish.
  //
  // Derived every render rather than captured when Finish was tapped. Stored, the message
  // outlived the condition: she saved the row it named and the prompt stayed on screen naming
  // a set that is now safely on the server. It also went stale in the other direction, still
  // naming both exercises after one was resolved.
  // `dirty` is what keeps a pre-filled row out of this list; see Pending.
  const unsavedNames = prescriptions
    .filter((prescription) => {
      const pending = blockFor(prescription.id ?? '').pending
      return pending.dirty && (pending.weight.trim() !== '' || pending.reps.trim() !== '')
    })
    .map((prescription) => prescription.exercise?.name ?? 'an exercise')

  // Two parts, and both have to hold: she asked the question, and the reason for asking it is
  // still true. Saving or clearing the row while the prompt is up takes it down by itself,
  // which is the same staleness argument as above applied to a control rather than a message.
  const confirmingDiscard = discardAsked && unsavedNames.length > 0

  // The prompt replaces the button that raised it, so without this focus drops to the body and
  // a keyboard or switch user has to walk the screen again to answer a question they just
  // asked. It lands on Cancel, which is also the harmless place for a reflex keypress to go.
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (confirmingDiscard) {
      cancelRef.current?.focus()
    }
  }, [confirmingDiscard])

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
      const { id: targetSession, restored } = await ensureSession()

      // Numbered from what the session really holds, not from what this handler captured before
      // asking. When ensureSession resumed a row, `block` predates knowing that row had sets in
      // it — using it is how numbering restarted at 1 on every reopen.
      const alreadyLogged = restored?.[key]?.saved.length ?? block.saved.length

      const saved = await logSet(targetSession, {
        exerciseId,
        programDayExerciseId: key,
        setNumber: alreadyLogged + 1,
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

  // Mirrors the server's renumbering (#105) onto the local copy: sets above the removed one
  // shift down, so the block stays 1..n and the next set number — saved.length + 1 — keeps
  // agreeing with what is actually in the row. Throws on failure; the block renders the error.
  async function onDeleteSet(prescriptionId: string, setId: string) {
    await deleteSet(setId)

    setBlocks((previous) => {
      const current = previous[prescriptionId]
      const removed = current?.saved.find((candidate) => candidate.id === setId)
      if (current === undefined || removed === undefined) {
        return previous
      }

      return {
        ...previous,
        [prescriptionId]: {
          ...current,
          saved: current.saved
            .filter((candidate) => candidate.id !== setId)
            .map((candidate) =>
              candidate.setNumber > removed.setNumber
                ? { ...candidate, setNumber: candidate.setNumber - 1 }
                : candidate,
            ),
          // The pending row is left exactly as it is. She may be part-way through typing the
          // next set while cleaning up a mistake in an earlier one.
        },
      }
    })
  }

  async function onFinish() {
    if (finishing) {
      return
    }

    // Nothing is written implicitly at Finish. A typed-but-unsaved row is the one place this
    // screen could still lose a set silently, so it asks before walking away from one.
    //
    // #45 refused instead, and told her to save or clear the row herself. The protection was
    // right and the cost was wrong: every saved set leaves a pre-filled row behind, so the row
    // that trips this is usually a stray tap on a field that already had numbers in it, and
    // the fix demanded was to delete digits she never typed. Asking keeps the guarantee —
    // nothing is dropped without her saying so — and spends one tap instead of a cleanup.
    if (unsavedNames.length > 0) {
      setDiscardAsked(true)
      return
    }

    await finishSession()
  }

  // Everything past the guard. The discard path enters here directly: reaching it means the
  // question this screen asks about unsaved work has been asked and answered, and re-checking
  // would only re-raise the prompt she just dismissed.
  async function finishSession() {
    setDiscardAsked(false)
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
        // A note but no sets logged this visit. POST takes a comment directly, so creating is
        // one request rather than a create followed by a patch.
        const { session, resumed } = await createSession({
          performedOn,
          programDayId: dayId,
          comment: trimmed,
        })

        // Unless the row already existed — reopening a day finished earlier reaches here with
        // no session id, and #98 deliberately leaves a resumed row's comment alone rather than
        // let a create overwrite what she already wrote. The note needs #96's PATCH to land;
        // without this it was posted, ignored, and lost without a word.
        if (resumed && session.id !== undefined) {
          await updateSessionComment(session.id, trimmed)
        }
      }

      clearDraft()
      navigate('/', { replace: true })
    } catch (caught) {
      // She is still on the screen and the row is still unsaved, so the next Finish asks again
      // rather than carrying over an answer given to an attempt that never landed.
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
              lastSets={lastTimes[prescription.exercise?.id ?? ''] ?? null}
              onChangeReps={(reps) => updatePending(prescription.id ?? '', { reps, dirty: true, failure: null })}
              onChangeWeight={(weight) =>
                updatePending(prescription.id ?? '', { weight, dirty: true, failure: null })
              }
              onDelete={(setId) => onDeleteSet(prescription.id ?? '', setId)}
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
          {/* Inline, in the bar the tap came from, rather than a dialog over the screen —
              DESIGN.md bans the modal as the first answer and #105 settled the same question
              for removing a set. The two choices replace the button that raised them, so there
              is never a Finish control on screen that does something other than what it says. */}
          {confirmingDiscard ? (
            <div aria-labelledby="discard-prompt" className="grid gap-2" role="group">
              <p className="text-base text-ink-bold" id="discard-prompt" role="alert">
                {discardPrompt(unsavedNames)}
              </p>
              {/* Cancel takes the bottom slot, where the thumb already is: Finish is the most
                  tapped control on this screen and a second tap out of habit has to land on
                  the harmless answer. Same reason the Remove control sits below its row. It
                  carries the accent for the same reason — amber is what to tap, and after this
                  question the safe answer is the one to reach for. */}
              <button
                className="grid min-h-[var(--tap-min)] w-full place-items-center rounded-md border border-edge px-4 text-base font-semibold text-danger"
                onClick={() => void finishSession()}
                type="button"
              >
                Discard
              </button>
              <button
                className="grid min-h-[var(--tap-min)] w-full place-items-center rounded-md bg-accent px-4 text-base font-semibold text-accent-ink hover:bg-accent-hover"
                onClick={() => setDiscardAsked(false)}
                ref={cancelRef}
                type="button"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              aria-describedby={finishError === null ? undefined : 'finish-error'}
              className="grid min-h-[var(--tap-min)] w-full place-items-center rounded-md bg-accent px-4 text-base font-semibold text-accent-ink hover:bg-accent-hover disabled:bg-surface-sunk disabled:text-muted"
              disabled={finishing}
              onClick={() => void onFinish()}
              type="button"
            >
              {finishing ? 'Saving' : 'Finish workout'}
            </button>
          )}
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
  lastSets,
  onChangeReps,
  onChangeWeight,
  onDelete,
  onSave,
  prescription,
}: {
  block: Block
  lastSets: LastSet[] | null
  onChangeReps: (value: string) => void
  onChangeWeight: (value: string) => void
  onDelete: (setId: string) => Promise<void>
  onSave: () => void
  prescription: PrescriptionView
}) {
  const exercise = prescription.exercise
  const name = exercise?.name ?? 'Exercise'
  const target = targetLine(prescription)
  const nextSetNumber = block.saved.length + 1

  // Which saved row has its actions showing. One at a time, per exercise.
  const [openSetId, setOpenSetId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<Failure | null>(null)

  async function remove(setId: string) {
    if (deleting) {
      return
    }

    setDeleting(true)
    setDeleteFailure(null)
    try {
      await onDelete(setId)
      setOpenSetId(null)
    } catch (caught) {
      setDeleteFailure(classify(caught))
    } finally {
      setDeleting(false)
    }
  }

  function toggle(setId: string) {
    setDeleteFailure(null)
    setOpenSetId((previous) => (previous === setId ? null : setId))
  }

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
        {/* One header row naming all four columns at the same height, rather than labels
            scattered down the block. aria-hidden throughout: every cell beneath already carries
            its own label — the values via visually-hidden text (see LastCell), the inputs via
            aria-label — because a header row has no programmatic association with the cells
            below it and would leave a row-by-row reading announcing bare numbers.

            kg and Reps are right-aligned to sit over right-aligned digits. Last is not: its
            values start at the left of their column. */}
        <div className={LOG_ROW_GRID} aria-hidden="true">
          <span />
          <span className="text-xs font-normal text-muted">Last</span>
          <span className="text-right text-xs font-normal text-muted">kg</span>
          <span className="text-right text-xs font-normal text-muted">Reps</span>
        </div>

        {block.saved.map((set) => (
          <SavedRow
            deleteFailure={openSetId === set.id ? deleteFailure : null}
            deleting={deleting}
            key={set.id}
            last={lastTimeFor(lastSets, set.setNumber)}
            onDelete={() => void remove(set.id)}
            onToggle={() => toggle(set.id)}
            open={openSetId === set.id}
            set={set}
          />
        ))}

        <div className={LOG_ROW_GRID}>
          {/* No bottom padding any more: with the unit labels moved to the header row every
              cell here is a single line, so items-end lands them on one edge. */}
          <span className="text-sm text-muted tabular-nums">{nextSetNumber}</span>

          {/* Rank 2. Its own column, left of the inputs, so successive sets stack into a
              vertical strip of last-time values (DESIGN.md §Log row). */}
          <LastCell set={lastTimeFor(lastSets, nextSetNumber)} />

          <NumberField
            inputMode="decimal"
            name={`${name} set ${nextSetNumber} weight in kilograms`}
            onChange={onChangeWeight}
            value={block.pending.weight}
          />
          <NumberField
            inputMode="numeric"
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
//
// The row is also the way to remove that set (#105). Two decisions behind that shape:
//
//   * No confirmation dialog. DESIGN.md calls the modal the lazy first answer, and a dialog for
//     a same-day typo is heavier than the mistake. Revealing is not destroying, so the first tap
//     is free — which is what lets the second one be immediate.
//   * The whole row is the target, not a small × inside it. A delete glyph sized to be safe on
//     a gym floor would dominate a row it is not the point of, and sized to fit would be a
//     mis-tap waiting to happen. The destructive control appears *below* the row instead, so a
//     second tap in the same place collapses it rather than landing on Delete — the finger has
//     to move to do damage.
function SavedRow({
  deleteFailure,
  deleting,
  last,
  onDelete,
  onToggle,
  open,
  set,
}: {
  deleteFailure: Failure | null
  deleting: boolean
  last: LastSet | undefined
  onDelete: () => void
  onToggle: () => void
  open: boolean
  set: SavedSet
}) {
  return (
    <div className="grid gap-2">
      {/* Labelled rather than read from its cells: "1 Last time – 100 8" is not a sentence, and
          the row's job here is to be one announceable thing that opens. */}
      <button
        aria-expanded={open}
        aria-label={savedRowLabel(set, last)}
        className={`${LOG_ROW_GRID} w-full rounded-sm text-left ${open ? 'bg-surface-sunk' : ''}`}
        onClick={onToggle}
        type="button"
      >
        <span className="text-sm text-muted tabular-nums">{set.setNumber}</span>
        <LastCell set={last} />
        <span className="text-right text-lg font-semibold text-ink-bold tabular-nums">
          {set.weightKg === null ? '—' : set.weightKg}
        </span>
        <span className="text-right text-lg font-semibold text-ink-bold tabular-nums">{set.reps}</span>
      </button>

      {open && (
        <div className="grid gap-2">
          {deleteFailure !== null && (
            <p className="text-sm text-danger" role="alert">
              {deleteFailure.message}
            </p>
          )}
          <button
            className="min-h-[var(--tap-min)] w-full rounded-sm border border-edge px-4 text-base font-semibold text-danger disabled:text-muted"
            disabled={deleting}
            onClick={onDelete}
            type="button"
          >
            {deleting ? 'Removing' : `Remove set ${set.setNumber}`}
          </button>
        </div>
      )}
    </div>
  )
}

// What the row announces. Includes last-time because the button's own contents stop being read
// separately once it carries a label, and that number is the reason the column exists.
function savedRowLabel(set: SavedSet, last: LastSet | undefined): string {
  const performed =
    set.weightKg === null
      ? `${set.reps} reps`
      : `${set.weightKg} kilograms by ${set.reps} reps`

  if (last === undefined) {
    return `Set ${set.setNumber}, ${performed}`
  }

  const previously =
    last.weightKg === null || last.weightKg === undefined
      ? `${last.reps} reps`
      : `${last.weightKg} kilograms by ${last.reps} reps`

  return `Set ${set.setNumber}, ${performed}. Last time ${previously}`
}

// Rank 2 (DESIGN.md §Log row): the weight × reps she hit last time, readable at arm's length
// mid-set without tapping anything. This is the feature that beats the paper notebook, so it
// gets --text-base / 600 / --ink and its own column — never a subtitle, a tooltip, an icon, or
// label styling, and never behind a tap. The × stays --muted at the same size as the numbers
// and is never bolded to balance the row; the numbers balance it.
//
// The label is visually hidden here and shown once as a column header instead. It cannot simply
// be dropped: a column header sits in a sibling row with no programmatic association to these
// cells, so a screen reader moving down the block would announce a bare "72.5 × 8" with nothing
// saying what it is. Hidden text costs sighted users nothing and keeps that context.
function LastCell({ set }: { set: LastSet | undefined }) {
  const value =
    set === undefined ? (
      // One dash, at --muted. Not "no data yet" copy — and it holds the row's place so the
      // strip stays aligned to set number when last time ran to fewer sets than today.
      <span className="text-base font-semibold text-muted tabular-nums">&ndash;</span>
    ) : (
      <span className="text-base font-semibold text-ink tabular-nums">
        {set.weightKg === null || set.weightKg === undefined ? (
          // Bodyweight (weight_kg NULL, database.md). Reps alone: "– × 8" would read as a
          // missing number rather than an absent one, and DESIGN.md gives no other glyph.
          set.reps
        ) : (
          <>
            {set.weightKg}
            <span className="text-muted"> × </span>
            {set.reps}
          </>
        )}
      </span>
    )

  return (
    <span>
      <span className="sr-only">Last time </span>
      {value}
    </span>
  )
}

/** Last time's set N, for this row's set N. Missing when she did fewer sets last time. */
function lastTimeFor(lastSets: LastSet[] | null, setNumber: number): LastSet | undefined {
  return lastSets?.find((candidate) => candidate.setNumber === setNumber)
}

// Rank 1 (DESIGN.md §Log row): --text-lg / 600 / --ink-bold, tabular-nums, digits right-aligned,
// 44px minimum. inputMode per ui-ux.md — a full keyboard for a number is a gym-floor failure.
//
// type="text" with an inputMode rather than type="number": number inputs scroll-wheel their own
// value, reject a locale's decimal comma, and put spinners inside a 44px target.
//
// The visible unit is in the block's header row. `name` still spells it out ("… weight in
// kilograms") because the header is aria-hidden and this is the input's only accessible name.
function NumberField({
  inputMode,
  name,
  onChange,
  value,
}: {
  inputMode: 'decimal' | 'numeric'
  name: string
  onChange: (value: string) => void
  value: string
}) {
  return (
    <input
      aria-label={name}
      autoComplete="off"
      className="min-h-[var(--tap-min)] w-full rounded-sm border border-edge bg-surface px-2 text-right text-lg font-semibold text-ink-bold tabular-nums"
      inputMode={inputMode}
      onChange={(event) => onChange(event.target.value)}
      type="text"
      value={value}
    />
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
 * Today's session for this program day, if one is already in history (#102).
 *
 * Matched on the triple #98 made unique — client (implicit, the endpoint is client-scoped),
 * performed_on, program_day_id — so the first hit is the only hit.
 *
 * Freestyle days return null: #98 deliberately leaves program_day_id NULL unconstrained, so
 * several freestyle sessions can share a date and there is no single row to resume. The log
 * screen never reaches that state today (a null day renders the not-in-your-program state
 * instead), but answering "I don't know" is the only correct answer if it ever does.
 */
function findSessionForDay(
  items: HistoryItem[],
  performedOn: string,
  dayId: string | null,
): string | null {
  if (dayId === null) {
    return null
  }

  for (const item of items) {
    const session = item.session
    if (
      session?.id !== undefined &&
      session.performedOn === performedOn &&
      session.programDayId === dayId
    ) {
      return session.id
    }
  }

  return null
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

/**
 * "Unsaved set on Back Squat. Discard and finish?"
 *
 * The exercise is named because not knowing which row holds the stray numbers is the whole
 * reason this is a question rather than a refusal — the answer changes if it turns out to be
 * the set she actually did.
 */
function discardPrompt(names: string[]): string {
  const subject = names.length === 1 ? 'Unsaved set on' : 'Unsaved sets on'
  return `${subject} ${listNames(names)}. Discard and finish?`
}

function listNames(names: string[]): string {
  if (names.length === 1) {
    return names[0]
  }

  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
