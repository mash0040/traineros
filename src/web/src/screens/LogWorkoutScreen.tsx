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
  updateSet,
} from '../lib/api'
import { NO_VALUE } from '../lib/glyphs'
import { targetLine } from '../lib/prescription'
import { dismissRowHint, rowHintDismissed } from '../lib/rowHint'
import {
  spokenUnit,
  toDisplay,
  toDisplayText,
  toKg,
  unitLabel,
  unitOf,
  type WeightUnit,
} from '../lib/weight'
import { clearDraft, readDraft, todayIn, writeDraft } from '../lib/workoutDraft'
import { useBlockMessage } from './blockMessage'
import { Message } from './Message'
import { WeightUnitToggle } from './WeightUnitToggle'

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
export function LogWorkoutScreen({
  me,
  onMeChanged,
}: {
  me: MeResponse
  onMeChanged: (me: MeResponse) => void
}) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const dayId = searchParams.get('day')

  // The display/input unit for this whole screen (#99). Everything below stays in canonical
  // kilograms — SavedSet.weightKg, the blocks, what goes on the wire — and this is consumed
  // only where a number is rendered or read back off an input.
  const unit = unitOf(me.weightUnit)

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

  /**
   * The one-time "rows are tappable" hint (#107).
   *
   * Read once at mount rather than on every render: `localStorage` is synchronous and this sits
   * in the render path of the screen DESIGN.md protects hardest. State, because dismissing has
   * to re-render, and the storage write is the durable half rather than the live one.
   */
  const [hintSeen, setHintSeen] = useState(rowHintDismissed)

  function dismissHint() {
    // Guarded, because `toggle` calls this on every open and close of every row: without it a
    // workout of twenty sets would write to localStorage on every tap to say the same thing.
    if (hintSeen) {
      return
    }

    dismissRowHint()
    setHintSeen(true)
  }

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

  // Same reasoning for the unit, which ensureSession's read-back needs to pre-fill the pending
  // row: putting it in the dependency array would rebuild the callback the moment the toggle
  // fires, and a rebuilt callback is a second `creating` promise, which is the duplicate
  // session guard 2 exists to prevent.
  const unitRef = useRef<WeightUnit>(unit)
  unitRef.current = unit

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
        fetchHistory({ limit: HISTORY_PAGE }).catch(() => null),
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
          : rebuildBlocks(items, resumedSession, wrapper.program ?? null, dayId, unit)

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

      const history = await fetchHistory({ limit: HISTORY_PAGE })
      const restored = rebuildBlocks(history.items ?? [], session.id, programRef.current, dayId, unitRef.current)

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

  /**
   * Which block carries the hint: the first one that actually has a saved row (#107).
   *
   * "On a client's first saved set", read literally. Once, not once per exercise — the lesson is
   * about rows in general, and a workout of six exercises would otherwise teach it six times.
   * The first block *with a row in it* rather than simply the first block, because the hint has
   * to point at something: on a screen where Bench is done and Squat is untouched, a line under
   * Squat's empty list describes rows that are not there.
   *
   * Derived, not stored. A set removed back to none takes the hint with it, and the block that
   * carries it moves with the rows rather than being remembered from whichever one was first.
   * Restored sets count: reopening a session mid-workout is a client who has saved sets.
   */
  const hintFor = hintSeen
    ? null
    : (prescriptions.find(
        (prescription) => blockFor(prescription.id ?? '').saved.length > 0,
      )?.id ?? null)

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

    // The input boundary (#99). What she typed is in her unit; what goes on the wire is
    // canonical kilograms, and nothing between here and the request sees the display number.
    // Validated before converting, so the message is about what she typed rather than about a
    // NaN that came out of a multiplication.
    const weightText = block.pending.weight.trim()
    const typedWeight = weightText === '' ? null : Number(weightText)
    if (typedWeight !== null && (!Number.isFinite(typedWeight) || typedWeight < 0)) {
      updatePending(key, { failure: { kind: 'rejected', message: 'Weight must be a number, or empty for bodyweight.' } })
      return
    }

    const weightKg = typedWeight === null ? null : toKg(typedWeight, unit)

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
          [key]: { saved: [...current.saved, row], pending: prefillFrom(row, unit) },
        }
      })
    } catch (caught) {
      // The typed values stay exactly where they are. Losing them here is the failure mode that
      // matters: she believes it saved, it did not, and she finds out never.
      updatePending(key, { saving: false, failure: classify(caught) })
    }
  }

  /**
   * Fix a set that is already saved (#107).
   *
   * PATCH /api/me/sets/:id has existed since #32 and nothing called it, so a client who typed
   * 100 for 10 had to remove the set and log it again. Editing is the commoner mistake.
   *
   * `weightKg` arrives canonical — the caller converted what was typed, the same boundary the
   * pending row's save crosses (#99) — and the local row is rebuilt from the *response*, not
   * from what was typed, so anything the server normalised is what ends up on screen.
   *
   * No renumbering here, unlike the delete beside it: editing a set changes what is in it, not
   * how many there are. `set_number` is deliberately not sent at all, even though the endpoint
   * accepts it — this screen numbers sets by position and nothing on it can reorder them.
   */
  async function onEditSet(
    prescriptionId: string,
    setId: string,
    weightKg: number | null,
    reps: number,
  ) {
    const updated = await updateSet(setId, { weightKg, reps })

    setBlocks((previous) => {
      const current = previous[prescriptionId]
      if (current === undefined) {
        return previous
      }

      return {
        ...previous,
        [prescriptionId]: {
          ...current,
          saved: current.saved.map((candidate) =>
            candidate.id === setId
              ? {
                  ...candidate,
                  weightKg: updated.weightKg ?? null,
                  reps: updated.reps ?? candidate.reps,
                }
              : candidate,
          ),
          // The pending row is left alone on purpose. It pre-fills from the last saved set, but
          // she may be part-way through typing the next one while correcting an earlier row, and
          // rewriting a field under a moving thumb is worse than a stale suggestion.
        },
      }
    })
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
      // The failure from an earlier Finish goes with the question that replaced it. Left set, it
      // would come back the moment she cancelled — a message about an attempt she has since
      // typed over, resurrected by a dismissal.
      setFinishError(null)
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
        <>
          {/* Once, above the first block, right-aligned over the weight columns (#99). Not per
              block: that would be one control per exercise all writing one setting, and the
              column header it would sit in is aria-hidden. See WeightUnitToggle. */}
          <WeightUnitToggle onMeChanged={onMeChanged} unit={unit} />

          {/* mt-3 rather than the mt-8 this list used to carry. The toggle took that gap over
              — it is what sits below the day title now — and 12px here keeps it reading as a
              label for the columns below rather than as a floating control. Net cost of the
              whole row is about 44px above the first exercise, which is the price of putting
              the setting where the question is asked. */}
          <ul className="mt-3 grid gap-6">
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
                onEdit={(setId, weightKg, reps) =>
                  onEditSet(prescription.id ?? '', setId, weightKg, reps)
                }
                onHintSeen={dismissHint}
                onSave={() => void onSaveSet(prescription)}
                prescription={prescription}
                showHint={hintFor === prescription.id}
                unit={unit}
              />
            ))}
          </ul>
        </>
      )}

      <SessionComment onChange={setComment} resumed={resumed} value={comment} />

      <div className="sticky bottom-0 -mx-6 mt-10 border-t border-edge bg-surface px-6 pb-8 pt-4 shadow-[var(--shadow-sticky)]">
        <div className="mx-auto grid w-full max-w-lg gap-2">
          {/* This footer's one message, and it is *derived* rather than stored — the case
              DESIGN.md §Messages carves out. The prompt has to disappear the moment she saves
              the unsaved row, and that row is in a different block entirely, so the question of
              whether to ask is not this block's to remember. `confirmingDiscard` is #46's
              derivation and this is the same idea one level up.

              The prompt wins over a finish failure: a dropped Finish that she has since typed
              into is no longer the live question. Stacked, which is what they did before, they
              were two panels in a bar with no room for one.

              The panel, in the footer that raised it. The prompt was --ink-bold body text with
              no border and no glyph, on the one bar in the app that is already --surface over
              --surface — so the question standing between a client and a lost set had less
              visual weight than the two buttons answering it. The failure tone is right and not
              a compromise: this prompt is about work about to be thrown away.

              It drops from --text-base to the panel's --text-sm, which DESIGN.md fixes for
              every tone so a message cannot change the height of the block it appears in. In a
              sticky footer that rule earns its keep twice over: the bar is pinned to the bottom,
              so anything that grows it pushes the whole thing up over the row she was last
              looking at. */}
          {confirmingDiscard ? (
            <Message id="finish-message" tone="prompt">
              {discardPrompt(unsavedNames)}
            </Message>
          ) : (
            finishError !== null && (
              <Message id="finish-message" tone="failure">
                {finishError}
              </Message>
            )
          )}

          {/* Inline, in the bar the tap came from, rather than a dialog over the screen —
              DESIGN.md bans the modal as the first answer and #105 settled the same question
              for removing a set. The two choices replace the button that raised them, so there
              is never a Finish control on screen that does something other than what it says. */}
          {confirmingDiscard ? (
            <div aria-labelledby="finish-message" className="grid gap-2" role="group">
              {/* Cancel takes the bottom slot, where the thumb already is: Finish is the most
                  tapped control on this screen and a second tap out of habit has to land on
                  the harmless answer. Same reason the Remove control sits below its row. It
                  carries the accent for the same reason — amber is what to tap, and after this
                  question the safe answer is the one to reach for. */}
              <button
                aria-describedby="finish-message"
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
              aria-describedby={finishError === null ? undefined : 'finish-message'}
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
//
// ── Declared once, distributed by subgrid (#138) ───────────────────────────────────────────
// This template used to be applied as a class to three independent grid containers: the header
// row, every saved row, and the pending input row. That is the shape #137 found misaligning
// the clients roster, where two containers holding one template string resolved it to two
// different layouts.
//
// It was not misaligning anything here, and the reason is worth stating so nobody "restores"
// it: every track is fixed or fr, and content-independent tracks resolve identically in any
// container of equal width. The roster drifted because two of its tracks were `auto`.
//
// So this was a loaded gun rather than a wound, and it is pointed at the one screen this
// document spends a whole section on. Adding a single `auto` track, or padding to any one of
// the three rows, would have broken the column alignment that §Log row depends on — silently,
// because nothing here would have looked wrong until a set was logged. One definition on the
// block, subgrid on the rows, and the failure mode is gone rather than deferred.
const LOG_BLOCK_GRID = 'grid grid-cols-[2rem_5rem_1fr_1fr] gap-x-3'

// What each row wears instead of a copy of the template: span the four tracks, take their
// sizes from the block. `items-end` stays per-row, because it is alignment within a row and
// not a property of the columns.
const LOG_ROW_GRID = 'col-span-4 grid grid-cols-subgrid items-end'

function ExerciseBlock({
  block,
  lastSets,
  onChangeReps,
  onChangeWeight,
  onDelete,
  onEdit,
  onHintSeen,
  onSave,
  prescription,
  showHint,
  unit,
}: {
  block: Block
  lastSets: LastSet[] | null
  onChangeReps: (value: string) => void
  onChangeWeight: (value: string) => void
  onDelete: (setId: string) => Promise<void>
  onEdit: (setId: string, weightKg: number | null, reps: number) => Promise<void>
  onHintSeen: () => void
  onSave: () => void
  prescription: PrescriptionView
  showHint: boolean
  unit: WeightUnit
}) {
  const exercise = prescription.exercise
  const name = exercise?.name ?? 'Exercise'
  const target = targetLine(prescription)
  const nextSetNumber = block.saved.length + 1

  // Per-block, because a session renders one of these per exercise and a bare "save-error"
  // would be the same id four times over — at which point aria-describedby points every Save
  // button at whichever block rendered first (#138, DESIGN.md §Messages).
  const pendingErrorId = `pending-error-${prescription.id ?? name}`

  // Which saved row has its actions showing. One at a time, per exercise.
  const [openSetId, setOpenSetId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * The open row's one slot, shared by Edit and Remove (#107).
   *
   * It was `deleteFailure` when Remove was the only action. The two cannot both be in flight —
   * the row is one block and each control disables while the other is working — so a second
   * slot would be a slot that is always empty, and #141's rule is that a block holds one
   * message.
   */
  const [actionFailure, setActionFailure] = useState<Failure | null>(null)

  /**
   * What is being typed into a saved row, or null if none is (#107).
   *
   * Held here rather than in SavedRow so that opening an edit *is* the row's state rather than
   * something the row remembers alongside it: there is one of these per block, so two rows
   * cannot be in edit mode at once and a stale draft cannot survive the row closing. Same
   * reasoning as `openSetId` directly above, and the two are cleared together.
   *
   * Strings, and in the client's display unit, exactly like `Pending.weight` — this is what
   * someone is typing, which is the one thing lib/weight.ts's header says is never canonical.
   */
  const [edit, setEdit] = useState<{ setId: string; weight: string; reps: string } | null>(null)

  // The receipt for a row action, held by the block because the row's own slot may be gone by
  // the time there is anything to say — after a removal the row itself is, and after an edit the
  // disclosure closes.
  //
  // Only `done` is used. The save failure that shares this slot is `block.pending.failure`,
  // which belongs to the screen because it also decides whether the Save button reads "Save set"
  // or "Try again", so it cannot move in here without splitting that. The slot is therefore
  // *derived* below rather than stored — DESIGN.md §Messages allows either, and this is the case
  // it allows it for: one message, computed, when the block does not own all of its inputs.
  const receipt = useBlockMessage(`receipt-${prescription.id ?? name}`)

  // One message. The failure wins, because a set that would not save is the live problem and a
  // receipt for a row changed a moment ago is not.
  const message: { tone: 'failure' | 'confirmation'; body: React.ReactNode; id: string } | null =
    block.pending.failure !== null
      ? { tone: 'failure', body: block.pending.failure.message, id: pendingErrorId }
      : receipt.message === null
        ? null
        : { tone: 'confirmation', body: receipt.message.body, id: receipt.id }

  async function remove(setId: string) {
    if (busy) {
      return
    }

    const setNumber = block.saved.find((candidate) => candidate.id === setId)?.setNumber

    setBusy(true)
    setActionFailure(null)
    receipt.clear()
    try {
      await onDelete(setId)
      setOpenSetId(null)
      setEdit(null)
      // Names the renumbering rather than only the removal, because the server renumbers the
      // sets above it (#105) and the local copy mirrors that: a client watching set 3 become
      // set 2 needs to know that is the fix and not a second mistake.
      receipt.done(
        setNumber === undefined
          ? 'Set removed. The rest are renumbered.'
          : `Set ${setNumber} removed. The rest are renumbered.`,
      )
    } catch (caught) {
      setActionFailure(classifyRowAction(caught))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Commit an edit. Returns whether it landed, so the row knows where to put focus.
   *
   * Validation mirrors the pending row's, field for field, because it is the same two fields
   * with the same rules — and mirrors the endpoint's, so a rejection costs no round trip on gym
   * wifi.
   */
  async function saveEdit(): Promise<boolean> {
    if (busy || edit === null) {
      return false
    }

    const set = block.saved.find((candidate) => candidate.id === edit.setId)
    if (set === undefined) {
      return false
    }

    const reps = Number.parseInt(edit.reps.trim(), 10)
    if (!Number.isInteger(reps) || reps <= 0) {
      setActionFailure({ kind: 'rejected', message: 'Enter how many reps you did.' })
      return false
    }

    const weightText = edit.weight.trim()
    const typedWeight = weightText === '' ? null : Number(weightText)
    if (typedWeight !== null && (!Number.isFinite(typedWeight) || typedWeight < 0)) {
      setActionFailure({
        kind: 'rejected',
        message: 'Weight must be a number, or empty for bodyweight.',
      })
      return false
    }

    // The one edit this endpoint cannot express. PATCH reads `weight_kg: null` as "leave it
    // alone" rather than "clear it", which MeSessionEndpoints records as a deliberate v1
    // decision — so emptying the field on a set that has a weight would send a request that
    // succeeds and changes nothing, and she would watch the old number come back. Refused here
    // with the workaround named, rather than sent and silently ignored. Tracked as its own
    // issue; widening the endpoint to tell absent from explicitly-null is a contract decision.
    //
    // A set that is *already* bodyweight is unaffected: its field starts empty, null means
    // "leave alone", and leaving null alone is exactly right.
    if (typedWeight === null && set.weightKg !== null) {
      setActionFailure({
        kind: 'rejected',
        message: 'To change this to bodyweight, remove the set and log it again without a weight.',
      })
      return false
    }

    setBusy(true)
    setActionFailure(null)
    receipt.clear()
    try {
      // The input boundary (#99), the same crossing the pending row's save makes: what she typed
      // is in her unit, what goes on the wire is canonical kilograms.
      await onEdit(edit.setId, typedWeight === null ? null : toKg(typedWeight, unit), reps)
      setOpenSetId(null)
      setEdit(null)
      receipt.done(`Set ${set.setNumber} updated.`)
      return true
    } catch (caught) {
      setActionFailure(classifyRowAction(caught))
      return false
    } finally {
      setBusy(false)
    }
  }

  function toggle(setId: string) {
    setActionFailure(null)
    // Opening or closing a row is an action in this block, so the receipt goes with it.
    receipt.clear()
    // A row that closes takes any half-typed edit with it. Reopening starts from what is saved,
    // which is the only value that is true of the set.
    setEdit(null)
    setOpenSetId((previous) => (previous === setId ? null : setId))
    // Opening a row is proof the hint landed, so it stops being shown from here on — on this
    // device, permanently. A client who has found the gesture does not need to be taught it, and
    // a hint that outlives its lesson is decoration.
    onHintSeen()
  }

  function startEdit(set: SavedSet) {
    setActionFailure(null)
    receipt.clear()
    // Seeded from the stored kilograms through the display boundary, so the field opens showing
    // exactly the number the row was showing a moment ago (#99). Bodyweight seeds empty, which
    // is what it reads as everywhere else.
    setEdit({
      setId: set.id,
      weight: toDisplayText(set.weightKg, unit),
      reps: String(set.reps),
    })
  }

  function cancelEdit() {
    setActionFailure(null)
    setEdit(null)
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

      {/* The one place the four columns are defined. Every row below spans them via subgrid;
          none of them restates the template. gap-y here rather than in LOG_BLOCK_GRID because
          the column gap belongs to the columns and travels with them, while the row rhythm is
          this block's own. */}
      <div className={`mt-4 gap-y-3 border-t border-edge pt-4 ${LOG_BLOCK_GRID}`}>
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
          <span className="text-right text-xs font-normal text-muted">{unitLabel(unit)}</span>
          <span className="text-right text-xs font-normal text-muted">Reps</span>
        </div>

        {block.saved.map((set) => (
          <SavedRow
            actionFailure={openSetId === set.id ? actionFailure : null}
            busy={busy}
            edit={edit !== null && edit.setId === set.id ? edit : null}
            key={set.id}
            last={lastTimeFor(lastSets, set.setNumber)}
            onCancelEdit={cancelEdit}
            onChangeEdit={(patch) => setEdit((previous) => (previous === null ? previous : { ...previous, ...patch }))}
            onDelete={() => void remove(set.id)}
            onSaveEdit={saveEdit}
            onStartEdit={() => startEdit(set)}
            onToggle={() => toggle(set.id)}
            open={openSetId === set.id}
            set={set}
            unit={unit}
          />
        ))}

        {/* The one-time hint (#107), directly under the rows it is about and above the row she
            is typing into, so it reads as a note on what is above rather than a label for what
            is below.

            Muted body text, not a Message. Message.tsx draws the line and it is the right one:
            a panel means something happened. Nothing happened here — this is an instruction, and
            giving it a tinted panel with a glyph would put it in the same visual class as a set
            that would not save.

            col-span-4 for the reason everything else in this grid carries it: a plain child auto
            flows into track 1, which is the 2rem set-number column, and this sentence would wrap
            down a 32px gutter. */}
        {showHint && (
          <p className="col-span-4 flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
            Tap a set to change or remove it.
            {/* An explicit dismissal as well as the automatic one in `toggle`, because a client
                who is never going to edit a set would otherwise carry this line through every
                workout until she happened to tap a row. Quiet: it is not an action on the
                workout, and DESIGN.md's accent belongs to the thing to tap. */}
            <button
              className="min-h-[var(--tap-min)] rounded-sm px-2 font-semibold text-ink underline underline-offset-4"
              onClick={onHintSeen}
              type="button"
            >
              Got it
            </button>
          </p>
        )}

        <div className={LOG_ROW_GRID}>
          {/* No bottom padding any more: with the unit labels moved to the header row every
              cell here is a single line, so items-end lands them on one edge. */}
          <span className="text-sm text-muted tabular-nums">{nextSetNumber}</span>

          {/* Rank 2. Its own column, left of the inputs, so successive sets stack into a
              vertical strip of last-time values (DESIGN.md §Log row). */}
          <LastCell set={lastTimeFor(lastSets, nextSetNumber)} unit={unit} />

          <NumberField
            inputMode="decimal"
            name={`${name} set ${nextSetNumber} weight in ${spokenUnit(unit)}`}
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

        {/* One slot: the set that would not save, or the receipt for the one that was removed.
            The row vanishing is *nearly* the confirmation, and on the save path it genuinely is
            one — a saved set turns into a row directly above the inputs, which is why there is
            no panel there and why twenty of them per workout would be intolerable. Delete is the
            other way round: the evidence is an absence, the rows below it renumber, and a client
            who tapped Remove on a gym floor and looked up is being asked to notice which of
            several rows is no longer there.

            col-span-4: the block is a four-track grid and a panel is not a column. Left as a
            grid item it would land in track 1 (the 2rem set-number column) and wrap to
            nothing. */}
        {message !== null && (
          <Message className="col-span-4" id={message.id} tone={message.tone}>
            {message.body}
          </Message>
        )}

        {/* Full-width and 44px: the second-most-tapped control on the screen, and the one that
            has to be hittable without looking. Its label carries the failure state, because
            "Try again" and "Save set" are different promises.

            `col-span-4` is not decoration, and its absence was a live defect at every width.
            This button is a direct child of the four-track block grid, and a grid item with no
            placement auto-flows into the next free slot — track 1, which is the `2rem`
            set-number column. So `w-full` was 100% of 32px: the most important control on the
            client's most important screen was a sliver with its label wrapped down the side of
            it. #138 introduced it by moving the column template up from the individual rows
            onto the block, which turned two plain siblings into grid items; nothing in the DOM
            changed, so nothing in a test could see it. The pending-failure panel above had the
            same defect and the same fix. */}
        <button
          aria-describedby={block.pending.failure === null ? undefined : pendingErrorId}
          className="col-span-4 grid min-h-[var(--tap-min)] w-full place-items-center rounded-sm border border-edge bg-surface-sunk px-4 text-base font-semibold text-ink disabled:text-muted"
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
  actionFailure,
  busy,
  edit,
  last,
  onCancelEdit,
  onChangeEdit,
  onDelete,
  onSaveEdit,
  onStartEdit,
  onToggle,
  open,
  set,
  unit,
}: {
  actionFailure: Failure | null
  busy: boolean
  /** Non-null while this row is being edited; the strings are in the display unit. */
  edit: { weight: string; reps: string } | null
  last: LastSet | undefined
  onCancelEdit: () => void
  onChangeEdit: (patch: { weight?: string; reps?: string }) => void
  onDelete: () => void
  onSaveEdit: () => Promise<boolean>
  onStartEdit: () => void
  onToggle: () => void
  open: boolean
  set: SavedSet
  unit: WeightUnit
}) {
  const editing = edit !== null
  const failureId = `row-error-${set.id}`

  const rowRef = useRef<HTMLButtonElement | null>(null)
  const editRef = useRef<HTMLButtonElement | null>(null)
  const weightRef = useRef<HTMLInputElement | null>(null)

  /**
   * Focus, which this row has to manage because it swaps the element under the client's finger.
   *
   * The row is a `<button>` at rest and a pair of inputs while editing — interactive content
   * cannot nest inside a button, so entering edit mode does not decorate the row, it replaces
   * it. Whatever had focus is unmounted at each of the three transitions, and focus left alone
   * falls back to `<body>`: a keyboard user is returned to the top of the document, and a screen
   * reader loses its place, in the middle of a workout.
   *
   * Requested as a target rather than called inline, because at each of these moments the
   * element being focused does not exist yet — it renders in the commit the same tap causes.
   */
  const [focusTarget, setFocusTarget] = useState<'row' | 'edit' | 'weight' | null>(null)
  useEffect(() => {
    if (focusTarget === null) {
      return
    }

    const target =
      focusTarget === 'row' ? rowRef.current : focusTarget === 'edit' ? editRef.current : weightRef.current
    target?.focus()
    setFocusTarget(null)
  }, [focusTarget])

  return (
    // A subgrid of the block, so the button inside it can be a subgrid in turn: a plain wrapper
    // here would break the chain, since subgrid needs its parent to be the grid whose tracks it
    // is borrowing. gap-y only — the column gap comes down from the block with the columns.
    <div className="col-span-4 grid grid-cols-subgrid gap-y-2">
      {editing ? (
        // The same four tracks, so the fields land exactly where the numbers were and exactly
        // where the pending row's fields are: set number and last-time do not move, and the two
        // inputs are the same width, in the same columns, as the ones directly below. That is
        // the whole argument for editing in place rather than in the strip — a second pair of
        // fields somewhere else on this screen is a second thing to aim at mid-set.
        //
        // A div, not the button above. An <input> inside a <button> is invalid content, and the
        // row is not a toggle while it is a field.
        <div className={`${LOG_ROW_GRID} rounded-sm bg-surface-sunk`}>
          <span className="text-sm text-muted tabular-nums">{set.setNumber}</span>
          <LastCell set={last} unit={unit} />
          <NumberField
            inputMode="decimal"
            name={`Set ${set.setNumber} weight in ${spokenUnit(unit)}`}
            onChange={(weight) => onChangeEdit({ weight })}
            ref={weightRef}
            value={edit.weight}
          />
          <NumberField
            inputMode="numeric"
            name={`Set ${set.setNumber} reps`}
            onChange={(reps) => onChangeEdit({ reps })}
            value={edit.reps}
          />
        </div>
      ) : (
        /* Labelled rather than read from its cells: "1 Last time – 100 8" is not a sentence, and
           the row's job here is to be one announceable thing that opens. */
        <button
          aria-expanded={open}
          aria-label={savedRowLabel(set, last, unit)}
          className={`${LOG_ROW_GRID} w-full rounded-sm text-left ${open ? 'bg-surface-sunk' : ''}`}
          onClick={onToggle}
          ref={rowRef}
          type="button"
        >
          <span className="text-sm text-muted tabular-nums">{set.setNumber}</span>
          <LastCell set={last} unit={unit} />
          {/* NO_VALUE, not a literal em dash. DESIGN.md §Absolute bans rules em dashes out of
              rendered strings, and this screen was rendering one for bodyweight while the roster
              rendered an en dash for the same idea. One glyph, one constant (#138).

              The display boundary (#99): the row holds canonical kilograms and reads out in the
              client's unit. Bodyweight is null in both units and keeps its dash. */}
          <span className="text-right text-lg font-semibold text-ink-bold tabular-nums">
            {set.weightKg === null ? NO_VALUE : toDisplay(set.weightKg, unit)}
          </span>
          <span className="text-right text-lg font-semibold text-ink-bold tabular-nums">{set.reps}</span>
        </button>
      )}

      {open && (
        // Full width under the row it belongs to, not part of the column layout.
        <div className="col-span-4 grid gap-2">
          {/* One slot for the row, shared by both actions (#141). Above the controls that write
              to it, per DESIGN.md §Messages. */}
          {actionFailure !== null && (
            <Message id={failureId} tone="failure">
              {actionFailure.message}
            </Message>
          )}

          {/* Two controls side by side rather than stacked: at 390px the block's own p-4 leaves
              about 326px here, which fits both comfortably, and stacking would put Remove a
              thumb-width below Edit on a screen where the row above is already the target of the
              tap that opened this. flex-1 keeps them equal so neither reads as the default. */}
          <div className="flex flex-wrap gap-2">
            {editing ? (
              <>
                <button
                  aria-describedby={actionFailure === null ? undefined : failureId}
                  className="min-h-[var(--tap-min)] flex-1 rounded-sm bg-accent px-4 text-base font-semibold text-accent-ink disabled:bg-surface-sunk disabled:text-muted"
                  disabled={busy}
                  onClick={() => {
                    void onSaveEdit().then((saved) => {
                      // Saved, so the disclosure closes and the fields are gone. Focus goes to
                      // the row itself, which is the surviving control and now shows the new
                      // numbers. Not to the confirmation: it is role="status", so it is spoken
                      // without stealing the caret from where she is working.
                      //
                      // Failed, so the fields stay exactly as typed and focus stays in them. The
                      // panel is role="alert" and announces itself; moving focus out of the
                      // field she has to correct would be taking her away from the fix.
                      if (saved) {
                        setFocusTarget('row')
                      }
                    })
                  }}
                  type="button"
                >
                  {busy ? 'Saving' : 'Save changes'}
                </button>
                <button
                  className="min-h-[var(--tap-min)] flex-1 rounded-sm border border-edge px-4 text-base font-semibold text-ink disabled:text-muted"
                  disabled={busy}
                  onClick={() => {
                    onCancelEdit()
                    // Back to the control that opened the fields, which is the standard return
                    // for a reveal and leaves her one tap from trying again.
                    setFocusTarget('edit')
                  }}
                  type="button"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  className="min-h-[var(--tap-min)] flex-1 rounded-sm border border-edge px-4 text-base font-semibold text-ink disabled:text-muted"
                  disabled={busy}
                  onClick={() => {
                    onStartEdit()
                    // The weight field, not the row: it is the first of the two and the likelier
                    // of them to be wrong, since it is the number that changes between sets.
                    setFocusTarget('weight')
                  }}
                  ref={editRef}
                  type="button"
                >
                  {`Edit set ${set.setNumber}`}
                </button>
                {/* --danger, and the only one of the four that carries it. Bordered at rest for
                    the reason trainerControls.ts records: a filled red block in every open row
                    reads as an alert about the row rather than a control in it. */}
                <button
                  aria-describedby={actionFailure === null ? undefined : failureId}
                  className="min-h-[var(--tap-min)] flex-1 rounded-sm border border-danger px-4 text-base font-semibold text-danger disabled:border-edge disabled:text-muted"
                  disabled={busy}
                  onClick={onDelete}
                  type="button"
                >
                  {busy ? 'Removing' : `Remove set ${set.setNumber}`}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// What the row announces. Includes last-time because the button's own contents stop being read
// separately once it carries a label, and that number is the reason the column exists.
function savedRowLabel(set: SavedSet, last: LastSet | undefined, unit: WeightUnit): string {
  // Spelled out rather than "kg"/"lb": a screen reader renders those unpredictably, and this
  // string is heard mid-set by someone who is not looking at the screen (#99).
  const spoken = spokenUnit(unit)

  const performed =
    set.weightKg === null
      ? `${set.reps} reps`
      : `${toDisplay(set.weightKg, unit)} ${spoken} by ${set.reps} reps`

  if (last === undefined) {
    return `Set ${set.setNumber}, ${performed}`
  }

  const previously =
    last.weightKg === null || last.weightKg === undefined
      ? `${last.reps} reps`
      : `${toDisplay(last.weightKg, unit)} ${spoken} by ${last.reps} reps`

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
function LastCell({ set, unit }: { set: LastSet | undefined; unit: WeightUnit }) {
  const value =
    set === undefined ? (
      // One dash, at --muted. Not "no data yet" copy — and it holds the row's place so the
      // strip stays aligned to set number when last time ran to fewer sets than today.
      // NO_VALUE rather than a literal `&ndash;`, so the three places this app says "nothing
      // here" say it with one glyph (#138). The sr-only text this cell already carries is
      // below, on the wrapper — the constant is the glyph only, never the label.
      <span className="text-base font-semibold text-muted tabular-nums">{NO_VALUE}</span>
    ) : (
      <span className="text-base font-semibold text-ink tabular-nums">
        {set.weightKg === null || set.weightKg === undefined ? (
          // Bodyweight (weight_kg NULL, database.md). Reps alone: "– × 8" would read as a
          // missing number rather than an absent one, and DESIGN.md gives no other glyph.
          set.reps
        ) : (
          <>
            {toDisplay(set.weightKg, unit)}
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
// value, reject a locale's decimal comma, and put spinners inside a 44px target. That decision
// still holds, and it is what rules out step increments here — see ui-ux.md §Gym-floor
// constraints for the attempt and why it came out.
//
// The visible unit is in the block's header row. `name` still spells it out ("… weight in
// kilograms") because the header is aria-hidden and this is the input's only accessible name.
function NumberField({
  inputMode,
  name,
  onChange,
  ref,
  value,
}: {
  inputMode: 'decimal' | 'numeric'
  name: string
  onChange: (value: string) => void
  /** #107 needs to put the caret in one of these on Edit. React 19 takes ref as a plain prop. */
  ref?: React.Ref<HTMLInputElement>
  value: string
}) {
  return (
    <input
      aria-label={name}
      autoComplete="off"
      className="min-h-[var(--tap-min)] w-full rounded-sm border border-edge bg-surface px-2 text-right text-lg font-semibold text-ink-bold tabular-nums"
      inputMode={inputMode}
      onChange={(event) => onChange(event.target.value)}
      ref={ref}
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

// Takes the unit because the pending row is the one piece of state on this screen that is not
// canonical: it is what someone is typing, so it has to be in the unit they type in (#99).
function prefillFrom(set: SavedSet, unit: WeightUnit): Pending {
  return {
    weight: toDisplayText(set.weightKg, unit),
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
  // Only for the pending pre-fill it builds. The SavedSets it returns stay canonical.
  unit: WeightUnit,
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
    blocks[prescription.id] = { saved, pending: prefillFrom(saved[saved.length - 1], unit) }
  }

  return blocks
}

function classify(caught: unknown): Failure {
  if (caught instanceof ApiError && caught.status === 0) {
    // status 0 is api.ts's marker for "fetch itself threw" — offline, DNS, refused connection.
    // Nothing reached the server, so the same tap is worth making again.
    return { kind: 'unreachable', message: 'No connection. Nothing was saved, so try again.' }
  }

  if (caught instanceof ApiError) {
    // The server answered and refused. Its message is written for the person reading it
    // (api.md keeps them human), so it is shown rather than replaced with a generic line.
    return { kind: 'rejected', message: caught.message }
  }

  return { kind: 'rejected', message: 'Something went wrong. Try again.' }
}

/**
 * `classify`, plus the one thing only this screen can know (#107).
 *
 * Both row actions run against endpoints whose same-day window rejects with a **404**, shaped
 * deliberately like a set that never existed so the timing rule cannot be probed (api.md #32).
 * `classify` shows an ApiError's own message because api.md keeps them written for a person —
 * and this is the one where that breaks down, because the server's message is the bare HTTP
 * reason phrase. A client who removed a set after midnight was shown **"Not Found"** mid-workout,
 * which has been live since #105 shipped the delete.
 *
 * The screen is the layer that can do better, and for the reason lib/apiMessages.ts gives on the
 * trainer side: the server answers about an id, while this row was on screen a second ago and
 * came out of this session's own history. The likely cause is the window, and the other one
 * (removed on another device) is covered by the same sentence, so it names the rule rather than
 * guessing which happened.
 *
 * Only for the two row actions. A 404 elsewhere on this screen — logging into a session that has
 * gone, say — means something else entirely.
 */
function classifyRowAction(caught: unknown): Failure {
  if (caught instanceof ApiError && caught.status === 404) {
    return {
      kind: 'rejected',
      message: 'This set can no longer be changed. Sets can only be edited on the day they were logged.',
    }
  }

  return classify(caught)
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
