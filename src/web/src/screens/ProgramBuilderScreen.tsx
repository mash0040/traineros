import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import type {
  DayView,
  ExerciseResponse,
  PrescriptionView,
  ProgramDetailResponse,
} from '../api/types.gen'
import {
  ApiError,
  createDay,
  createPrescription,
  deleteDay,
  deletePrescription,
  fetchExercises,
  fetchProgram,
  reorderDayExercises,
  updateDay,
  updatePrescription,
  updateProgram,
} from '../lib/api'
import { messageFor } from '../lib/apiMessages'
import { TrainerMessage } from './TrainerMessage'
import { TrainerShell } from './TrainerShell'
import {
  trainerDanger,
  trainerField,
  trainerLink,
  trainerPrimary,
  trainerSecondary,
  trainerSelected,
} from './trainerControls'

type Load = 'loading' | 'ready' | 'missing' | 'unreachable'

const STATUSES = ['draft', 'active', 'archived']

// ui-ux.md §Trainer screens, Program builder: "days → prescriptions; add exercise from library;
// drag-or-buttons reorder". #53 built the day and prescription editing; #54 filled in the two
// controls it left disabled — the picker and the reorder buttons.
//
// ── Reordering days is deliberately not here ───────────────────────────────────────────────
// Prescriptions reorder through PATCH /api/days/:id/order, which takes the complete list and
// rewrites positions 1..N in one transaction. Days have no equivalent: they carry a position
// and PATCH /api/days/:id accepts it one row at a time. Reordering four days would be four
// requests with no transaction around them, and a failure in the middle leaves two days
// claiming the same position — which every reader of this tree then orders arbitrarily,
// including the client's Today screen. api.md rejected fractional positions to avoid exactly
// that class of drift; doing it by hand here would reintroduce it in the client's view of
// their own week. The fix is an endpoint that mirrors the prescription one, which is API work
// and not this ticket.
//
// ── One read, then local state ─────────────────────────────────────────────────────────────
// GET /api/programs/:id returns the whole tree — days, their prescriptions, each prescription's
// exercise — since the tree-read ticket. Every write endpoint returns the row it changed, so
// this screen folds those responses into its copy instead of re-reading. Refetching after each
// save would be simpler and would also throw away focus and scroll on a screen that exists to
// take a long sequence of small edits.
//
// ── Free text is not a lenient number ──────────────────────────────────────────────────────
// target_reps and target_load are text columns by design (database.md): "8–10", "AMRAP",
// "RPE 8", "5/3/1" are all real prescriptions a trainer writes. So those two are text inputs
// and render verbatim. target_sets and rest_seconds are genuinely integers and get number
// inputs. Getting this backwards would quietly forbid half the prescriptions in the sport.
export function ProgramBuilderScreen() {
  const { programId = '' } = useParams()

  const [load, setLoad] = useState<Load>('loading')
  const [program, setProgram] = useState<ProgramDetailResponse | null>(null)
  const [library, setLibrary] = useState<ExerciseResponse[]>([])
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoad('loading')

    // The library is fetched once for the screen rather than per day: it is the same list
    // whichever day is being filled in, and one request beats one per day on a program with
    // five of them.
    Promise.all([fetchProgram(programId), fetchExercises()])
      .then(([tree, exercises]) => {
        if (!cancelled) {
          setProgram(tree)
          setLibrary(exercises)
          setLoad('ready')
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return
        }
        // A program id belonging to another trainer is a 404 exactly like a fabricated one,
        // which is the point — nothing here can tell a trainer that someone else's program
        // exists. Both land on the same screen.
        setLoad(caught instanceof ApiError && caught.status === 404 ? 'missing' : 'unreachable')
      })

    return () => {
      cancelled = true
    }
  }, [programId, attempt])

  /**
   * What the picker may offer: the trainer's library minus anything retired.
   *
   * #26 soft-deletes, and GET /api/exercises deliberately returns inactive rows too so the
   * library screen can bring one back. But #28 refuses a retired exercise on a new
   * prescription with 400 unknown_exercise, so listing one here would be offering a choice the
   * server has already made. Filtered once, at the top, rather than in each day's form.
   *
   * Prescriptions that already name a retired exercise are a separate question and keep
   * rendering — the tree read carries the exercise whether or not it is active, which is what
   * lets a trainer see the thing they need to replace.
   */
  const selectable = library.filter((exercise) => exercise.isActive !== false)

  function replaceDays(days: DayView[]) {
    setProgram((previous) => (previous === null ? previous : { ...previous, days }))
  }

  if (load === 'loading') {
    return (
      <TrainerShell>
        <p className="text-base text-muted" role="status">
          Loading this program
        </p>
      </TrainerShell>
    )
  }

  if (load === 'missing') {
    return (
      <TrainerShell>
        <h1 className="text-xl font-semibold text-ink-bold">Program not found</h1>
        <p className="mt-2 text-base text-muted">
          It may belong to another trainer, or the link may be wrong.
        </p>
        <Link className={`mt-6 inline-block text-base text-ink ${trainerLink}`} to="/clients">
          Back to clients
        </Link>
      </TrainerShell>
    )
  }

  if (load === 'unreachable' || program === null) {
    return (
      <TrainerShell>
        <h1 className="text-xl font-semibold text-ink-bold">We couldn&rsquo;t load this program</h1>
        <p className="mt-2 text-base text-muted">Check your connection and try again.</p>
        {/* The accent: the only action on a screen that otherwise failed to load. */}
        <button
          className={`mt-6 ${trainerPrimary}`}
          onClick={() => setAttempt((previous) => previous + 1)}
          type="button"
        >
          Try again
        </button>
      </TrainerShell>
    )
  }

  const days = program.days ?? []

  return (
    <TrainerShell>
      {program.clientId != null && (
        <Link className={`text-sm text-muted ${trainerLink}`} to={`/clients/${program.clientId}`}>
          Back to client
        </Link>
      )}

      <h1 className="mt-4 text-xl font-semibold text-ink-bold">{program.title}</h1>

      <ProgramStatus
        onChanged={(updated) =>
          setProgram((previous) => (previous === null ? previous : { ...previous, status: updated.status }))
        }
        programId={programId}
        status={program.status ?? 'draft'}
      />

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-ink-bold">Days</h2>

        {days.length === 0 ? (
          <p className="mt-2 text-base text-muted">No days yet. Add the first one below.</p>
        ) : (
          <ul className="mt-4 grid gap-6">
            {days.map((day) => (
              <Day
                day={day}
                key={day.id}
                library={selectable}
                onChanged={(next) =>
                  replaceDays(days.map((candidate) => (candidate.id === next.id ? next : candidate)))
                }
                onDeleted={() => replaceDays(days.filter((candidate) => candidate.id !== day.id))}
              />
            ))}
          </ul>
        )}

        <AddDay
          onAdded={(created) =>
            replaceDays([
              ...days,
              // The create response is a ProgramDayResponse, which has no prescriptions array
              // because a new day has none. Given an empty one here so the day renders like any
              // other rather than as a special case until the next reload.
              { id: created.id, title: created.title, position: created.position, prescriptions: [] },
            ])
          }
          programId={programId}
        />
      </section>
    </TrainerShell>
  )
}

// AC item 2: the transition, and the one conflict it can hit.
//
// #27 leaves transitions unrestricted between draft/active/archived — any to any — with a
// single structural gate: a partial unique index means one active program per client, so
// activating a second is a 409 rather than a silent swap. That 409 is the only failure here a
// trainer can act on, and its meaning ("archive the other one first") is not in the status code.
function ProgramStatus({
  onChanged,
  programId,
  status,
}: {
  onChanged: (program: { status?: string | null }) => void
  programId: string
  status: string
}) {
  const [saving, setSaving] = useState<string | null>(null)

  /**
   * The last transition asked for and how it went — not a rendered message.
   *
   * #46's lesson, which this control had shipped a fresh copy of. A captured error string
   * outlives the condition it describes: the 409 named a conflict with some other program, and
   * then sat on screen through day edits, renames, and deletes until a reload, because nothing
   * else on this screen had any reason to touch it. Worse, the "never mind" gesture — clicking
   * the status the program is already in — hit an early return placed above the clear, so the
   * one action a trainer would take to dismiss it was the one action that could not.
   */
  const [attempt, setAttempt] = useState<{ status: string; message: string | null } | null>(null)

  // Derived every render. Two parts, and both have to hold: a transition was refused, and the
  // program is still not in the status that was refused. So the message goes when the trainer
  // asks for something else, and it goes on its own if the program reaches that status by any
  // route — including a retry that succeeds because they archived the other program in the
  // meantime, which is exactly what the message told them to do.
  const conflict =
    attempt !== null && attempt.message !== null && attempt.status !== status ? attempt.message : null

  async function choose(next: string) {
    if (saving !== null) {
      return
    }

    // Recorded before the no-op check rather than after it. Clicking the current status is how
    // someone dismisses a message about a transition they have thought better of, and under
    // the old order that click returned early and left the message standing.
    setAttempt({ status: next, message: null })
    if (next === status) {
      return
    }

    setSaving(next)
    try {
      onChanged(await updateProgram(programId, { status: next }))
    } catch (caught) {
      // This used to concatenate an instruction onto the server's own sentence, which meant the
      // trainer read one sentence written for them and one written for a developer, joined. The
      // whole message for program_active_conflict now lives in the copy map, so rewording the
      // API's string cannot change what a trainer sees here.
      setAttempt({ status: next, message: messageFor(caught, 'program') })
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="mt-4">
      {/* flex-wrap: three 44px buttons at ~80px each plus gaps is most of a 390px viewport, and
          "Archived" saving reads "Saving", which is wider. It wraps rather than overflows. */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Program status">
        {/* Inverted for the current status, bordered for the two you could move to.
            #132: this group used to paint the *current* status in solid amber, which is the one
            button in the row that does nothing when pressed. DESIGN.md gives amber exactly one
            job — "amber means the thing to tap" — and spending it on the already-selected state
            told a trainer to press the status they were already in, while the two real
            transitions sat next to it looking like nothing.

            Taking the amber off was step one; the first replacement was --surface-sunk, which
            the browser pass caught as its own regression. At 97% against a 99% surface that is
            about 1.03:1, so "is this program active or archived" was answered by a difference
            you cannot see across a desk. This is the whole reason a trainer opens this screen,
            and it was the faintest thing on it. Inverted neutral now, per DESIGN.md §Controls. */}
        {STATUSES.map((candidate) => {
          const current = candidate === status
          return (
            <button
              aria-pressed={current}
              className={current ? trainerSelected : trainerSecondary}
              disabled={saving !== null}
              key={candidate}
              onClick={() => void choose(candidate)}
              type="button"
            >
              {saving === candidate ? 'Saving' : capitalize(candidate)}
            </button>
          )
        })}
      </div>

      {conflict !== null && (
        <TrainerMessage className="mt-2" tone="failure">
          {conflict}
        </TrainerMessage>
      )}
    </div>
  )
}

function Day({
  day,
  library,
  onChanged,
  onDeleted,
}: {
  day: DayView
  library: ExerciseResponse[]
  onChanged: (day: DayView) => void
  onDeleted: () => void
}) {
  const [title, setTitle] = useState(day.title ?? '')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reordering, setReordering] = useState(false)
  const [reorderError, setReorderError] = useState<string | null>(null)

  const prescriptions = day.prescriptions ?? []

  /**
   * Move one row one place, by sending the whole list.
   *
   * #28 takes the day's complete prescription id list and rewrites positions 1..N in one
   * transaction; anything partial — a subset, a duplicate, an id from another day — is a 400
   * as a whole. So "move up" is not a request about one row, it is the entire order restated
   * with two entries swapped. That is the trade api.md made when it rejected fractional
   * positions: every reorder is a bigger request, and no reorder can leave the day in a state
   * where two prescriptions claim the same slot.
   *
   * Sent before the list moves on screen, rather than moved optimistically and rolled back.
   * There is no revert path to get wrong, and a reorder that appears to work and silently
   * did not is the failure worth avoiding on a screen whose output another person trains from.
   */
  async function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (reordering || day.id === undefined || target < 0 || target >= prescriptions.length) {
      return
    }

    const reordered = [...prescriptions]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(target, 0, moved)

    const orderedIds = reordered
      .map((prescription) => prescription.id)
      .filter((id): id is string => id !== undefined)
    if (orderedIds.length !== reordered.length) {
      // A row with no id cannot be named in the list, and a list missing one is a 400. Nothing
      // sensible to send, so nothing is sent.
      return
    }

    setReordering(true)
    setReorderError(null)
    try {
      await reorderDayExercises(day.id, orderedIds)
      // 204, so the new positions are applied here. Renumbered 1..N to match what the server
      // just wrote, rather than carrying the old numbers into a new order.
      onChanged({
        ...day,
        prescriptions: reordered.map((prescription, position) => ({ ...prescription, position: position + 1 })),
      })
    } catch (caught) {
      // 'day': the reorder is a write to the day, so a 404 means the day is gone rather than
      // any one exercise. A rejected id inside the list comes back as its own code.
      setReorderError(messageFor(caught, 'day'))
    } finally {
      setReordering(false)
    }
  }

  async function rename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || day.id === undefined) {
      return
    }

    // Mirrors #28's own check. Its message says "title cannot be blank", which is true and
    // says nothing about which of several days it means.
    if (title.trim() === '') {
      setError('A day needs a name.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const updated = await updateDay(day.id, { title: title.trim() })
      onChanged({ ...day, title: updated.title })
    } catch (caught) {
      setError(messageFor(caught, 'day'))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (deleting || day.id === undefined) {
      return
    }

    setDeleting(true)
    setError(null)
    try {
      await deleteDay(day.id)
      onDeleted()
    } catch (caught) {
      setError(messageFor(caught, 'day'))
      setDeleting(false)
    }
  }

  return (
    // p-4 below sm:. This card nests another (the prescription rows), so the two paddings
    // compound: at p-6 outside and p-4 inside, a 390px viewport was down to ~246px of usable
    // width by the time it reached a set/reps field.
    <li className="rounded-md border border-edge p-4 sm:p-6">
      <form className="flex flex-wrap items-end gap-3" noValidate onSubmit={rename}>
        <div className="grid gap-2">
          <label className="text-sm font-semibold text-ink" htmlFor={`day-title-${day.id}`}>
            Day name
          </label>
          {/* The message goes as soon as the trainer starts fixing what it named, same as the
              log screen's set rows. "A day needs a name" outliving the moment a name is typed
              is the same staleness the status control had. */}
          <input
            className={trainerField}
            id={`day-title-${day.id}`}
            name="title"
            onChange={(event) => {
              setTitle(event.target.value)
              setError(null)
            }}
            value={title}
          />
        </div>
        {/* The submit of this form, so it takes the accent on the same rule the prescription
            rows and the two add-forms already follow: amber commits the form it sits in. It was
            the odd one out, rendering identically to the reorder arrows a few pixels below. */}
        <button className={trainerPrimary} disabled={saving} type="submit">
          {saving ? 'Saving' : 'Save name'}
        </button>
      </form>

      {error !== null && (
        <TrainerMessage className="mt-2" tone="failure">
          {error}
        </TrainerMessage>
      )}

      <ul className="mt-6 grid gap-4">
        {prescriptions.length === 0 ? (
          <p className="text-base text-muted">Nothing prescribed on this day yet.</p>
        ) : (
          prescriptions.map((prescription, index) => (
            <Prescription
              canMoveDown={index < prescriptions.length - 1}
              canMoveUp={index > 0}
              key={prescription.id}
              onChanged={(next) =>
                onChanged({
                  ...day,
                  prescriptions: prescriptions.map((candidate) =>
                    candidate.id === next.id ? next : candidate,
                  ),
                })
              }
              onDeleted={() =>
                onChanged({
                  ...day,
                  prescriptions: prescriptions.filter((candidate) => candidate.id !== prescription.id),
                })
              }
              onMoveDown={() => void move(index, 1)}
              onMoveUp={() => void move(index, -1)}
              prescription={prescription}
              reordering={reordering}
            />
          ))
        )}
      </ul>

      {reorderError !== null && (
        <TrainerMessage className="mt-2" tone="failure">
          {reorderError}
        </TrainerMessage>
      )}

      <AddPrescription
        dayId={day.id ?? ''}
        library={library}
        onAdded={(created) =>
          onChanged({
            ...day,
            // Appended, because #28 assigns the new prescription the position after the current
            // maximum. Putting it anywhere else here would disagree with the server until the
            // next read.
            prescriptions: [...prescriptions, created],
          })
        }
      />

      <div className="mt-6 border-t border-edge pt-4">
        {confirming ? (
          <div className="grid justify-items-start gap-2" role="group">
            {/* #17: the delete cascades to this day's prescriptions, but logged history is
                ON DELETE SET NULL on both workout_sessions.program_day_id and
                logged_sets.program_day_exercise_id. A trainer hesitating over this button is
                usually worried about erasing what the client already did, and the honest answer
                is that they cannot. Saying so is the difference between a confident edit and a
                program nobody dares tidy up. */}
            <p className="text-sm text-ink-bold">
              Delete {day.title}? Its exercises go with it.
            </p>
            <p className="text-sm text-muted">
              Workouts your client already logged stay in their history. They just stop pointing
              at this day.
            </p>
            <div className="flex gap-2">
              <button className={trainerDanger} disabled={deleting} onClick={() => void remove()} type="button">
                {deleting ? 'Deleting' : 'Delete day'}
              </button>
              {/* Bordered, matching the prescription row's "Keep it" below. These two prompts
                  used to disagree with each other: one dismissal was amber, the other was not. */}
              <button className={trainerSecondary} onClick={() => setConfirming(false)} type="button">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className={trainerDanger} onClick={() => setConfirming(true)} type="button">
            Delete {day.title}
          </button>
        )}
      </div>
    </li>
  )
}

// One prescription row. Every field #28 accepts except exercise_id, which is a swap and
// therefore the picker's (#54).
//
// The form sends all five fields on every save rather than only the changed ones. #28's
// convention is that a null on the wire leaves a field alone and a blank string clears it to
// NULL, so sending the whole set is what makes clearing a load or a note possible at all.
function Prescription({
  canMoveDown,
  canMoveUp,
  onChanged,
  onDeleted,
  onMoveDown,
  onMoveUp,
  prescription,
  reordering,
}: {
  canMoveDown: boolean
  canMoveUp: boolean
  onChanged: (prescription: PrescriptionView) => void
  onDeleted: () => void
  onMoveDown: () => void
  onMoveUp: () => void
  prescription: PrescriptionView
  reordering: boolean
}) {
  const [targetSets, setTargetSets] = useState(String(prescription.targetSets ?? ''))
  const [targetReps, setTargetReps] = useState(prescription.targetReps ?? '')
  const [targetLoad, setTargetLoad] = useState(prescription.targetLoad ?? '')
  const [restSeconds, setRestSeconds] = useState(
    prescription.restSeconds == null ? '' : String(prescription.restSeconds),
  )
  const [note, setNote] = useState(prescription.note ?? '')

  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const name = prescription.exercise?.name ?? 'Exercise'

  // Both notes describe the last save, so both go the moment a field moves — at which point
  // they are describing something that is no longer what is on screen. Same rule the log
  // screen applies to its set rows, and the same one the status control above needed.
  function edited() {
    setSaved(false)
    setError(null)
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || prescription.id === undefined) {
      return
    }

    const sets = Number.parseInt(targetSets.trim(), 10)
    if (!Number.isInteger(sets) || sets <= 0) {
      setError('Sets must be a whole number above zero.')
      return
    }

    if (targetReps.trim() === '') {
      setError('Reps are required. Anything goes: 8–10, AMRAP, RPE 8.')
      return
    }

    const rest = restSeconds.trim()
    const restValue = rest === '' ? null : Number.parseInt(rest, 10)
    if (restValue !== null && (!Number.isInteger(restValue) || restValue <= 0)) {
      setError('Rest must be a whole number of seconds, or empty.')
      return
    }

    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const updated = await updatePrescription(prescription.id, {
        targetSets: sets,
        targetReps: targetReps.trim(),
        // Blank clears to NULL, which is exactly what an emptied field should mean.
        targetLoad: targetLoad.trim(),
        restSeconds: restValue,
        note: note.trim(),
      })

      onChanged({
        ...prescription,
        targetSets: updated.targetSets,
        targetReps: updated.targetReps,
        targetLoad: updated.targetLoad,
        restSeconds: updated.restSeconds,
        note: updated.note,
      })
      setSaved(true)
    } catch (caught) {
      setError(messageFor(caught, 'prescription'))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (deleting || prescription.id === undefined) {
      return
    }

    setDeleting(true)
    setError(null)
    try {
      await deletePrescription(prescription.id)
      onDeleted()
    } catch (caught) {
      setError(messageFor(caught, 'prescription'))
      setDeleting(false)
    }
  }

  return (
    <li className="rounded-sm border border-edge bg-surface-sunk p-4">
      <div className="flex items-baseline justify-between gap-4">
        {/* min-w-0 so the name yields to the arrows rather than pushing them off the card: a
            flex item's default minimum is min-content, which for an unbroken exercise name is
            the whole word. The arrows keep shrink-0 — they are 44px targets and there is
            nothing in them to compress — which is exactly why this side has to give. */}
        <h3 className="min-w-0 text-base font-semibold wrap-break-word text-ink-bold">{name}</h3>

        {/* Buttons, not drag. ui-ux.md calls buttons acceptable in v1 and drag polish, and the
            trade is real: a keyboard user gets the same two controls a mouse user does, and
            neither depends on a pointer gesture that has to be re-implemented for touch.

            The labels name the exercise because a day of five rows otherwise offers ten
            controls all called "Move up", and a screen reader moving through them has no way
            to tell which row it is on.

            Bordered and quiet on purpose (#132): reordering rearranges what is already there
            and writes nothing new, and a day of five rows carries ten of these. Ten accented
            arrows would be most of the colour on the screen. */}
        <div className="flex shrink-0 gap-1">
          <button
            aria-label={`Move ${name} up`}
            className={trainerSecondary}
            disabled={!canMoveUp || reordering}
            onClick={onMoveUp}
            type="button"
          >
            <span aria-hidden="true">↑</span>
          </button>
          <button
            aria-label={`Move ${name} down`}
            className={trainerSecondary}
            disabled={!canMoveDown || reordering}
            onClick={onMoveDown}
            type="button"
          >
            <span aria-hidden="true">↓</span>
          </button>
        </div>
      </div>

      <form className="mt-3 grid gap-3" noValidate onSubmit={save}>
        <div className="flex flex-wrap gap-3">
          <Field label="Sets" name={`sets-${prescription.id}`}>
            <input
              className={`w-20 ${trainerField}`}
              id={`sets-${prescription.id}`}
              inputMode="numeric"
              min={1}
              name="targetSets"
              onChange={(event) => {
                setTargetSets(event.target.value)
                edited()
              }}
              type="number"
              value={targetSets}
            />
          </Field>

          {/* Text, not a number. database.md: "8–10", "AMRAP", "RPE 8", "5/3/1" are real
              prescriptions, and a numeric input would refuse every one of them. */}
          <Field label="Reps" name={`reps-${prescription.id}`}>
            <input
              className={`w-32 ${trainerField}`}
              id={`reps-${prescription.id}`}
              name="targetReps"
              onChange={(event) => {
                setTargetReps(event.target.value)
                edited()
              }}
              placeholder="8–10"
              type="text"
              value={targetReps}
            />
          </Field>

          {/* Also text, and for the same reason: "70 kg", "bodyweight", "80% 1RM". */}
          <Field label="Load" name={`load-${prescription.id}`}>
            <input
              className={`w-32 ${trainerField}`}
              id={`load-${prescription.id}`}
              name="targetLoad"
              onChange={(event) => {
                setTargetLoad(event.target.value)
                edited()
              }}
              placeholder="70 kg"
              type="text"
              value={targetLoad}
            />
          </Field>

          {/* Genuinely a number, so it gets a number input. */}
          <Field label="Rest (seconds)" name={`rest-${prescription.id}`}>
            <input
              className={`w-28 ${trainerField}`}
              id={`rest-${prescription.id}`}
              inputMode="numeric"
              min={1}
              name="restSeconds"
              onChange={(event) => {
                setRestSeconds(event.target.value)
                edited()
              }}
              type="number"
              value={restSeconds}
            />
          </Field>
        </div>

        <Field label="Note" name={`note-${prescription.id}`}>
          <input
            className={`w-full ${trainerField}`}
            id={`note-${prescription.id}`}
            name="note"
            onChange={(event) => {
              setNote(event.target.value)
              edited()
            }}
            placeholder="Brace before you unrack."
            type="text"
            value={note}
          />
        </Field>

        {error !== null && (
          <TrainerMessage tone="failure">{error}</TrainerMessage>
        )}
        {saved && error === null && (
          <TrainerMessage tone="confirmation">Saved.</TrainerMessage>
        )}

        <div className="flex gap-2">
          <button className={trainerPrimary} disabled={saving} type="submit">
            {saving ? 'Saving' : 'Save'}
          </button>

          {confirming ? (
            <>
              <button className={trainerDanger} disabled={deleting} onClick={() => void remove()} type="button">
                {deleting ? 'Deleting' : `Delete ${name}`}
              </button>
              <button className={trainerSecondary} onClick={() => setConfirming(false)} type="button">
                Keep it
              </button>
            </>
          ) : (
            /* --danger, like the day delete above it. This one was bordered neutral, so the
               control that removes an exercise from a client's program looked exactly like the
               Save beside it minus the amber. */
            <button className={trainerDanger} onClick={() => setConfirming(true)} type="button">
              Delete
            </button>
          )}
        </div>

        {/* Same reassurance as the day delete, and the same reason (#17): the client's logged
            sets are ON DELETE SET NULL against this row, so they survive keyed by the exercise
            itself. Removing a prescription edits the plan, never the record of what happened. */}
        {confirming && (
          <p className="text-sm text-muted">
            Sets your client already logged against {name} stay in their history.
          </p>
        )}
      </form>
    </li>
  )
}

/**
 * The picker (#54), and the smallest form that satisfies POST /api/days/:id/exercises.
 *
 * Three fields, because three is what the endpoint requires: exercise_id, target_sets, and
 * target_reps. Load, rest and note are optional there and are left to the row editor rather
 * than duplicated here — the row appears directly below with every field on it, so a second
 * copy of that form would be two places to keep in step for no gain.
 */
function AddPrescription({
  dayId,
  library,
  onAdded,
}: {
  dayId: string
  library: ExerciseResponse[]
  onAdded: (prescription: PrescriptionView) => void
}) {
  const [exerciseId, setExerciseId] = useState('')
  // Three is the overwhelmingly common answer and the field is required, so defaulting it
  // saves typing the same digit on every row. It is a starting value, not a policy.
  const [targetSets, setTargetSets] = useState('3')
  const [targetReps, setTargetReps] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function edited() {
    setError(null)
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) {
      return
    }

    if (exerciseId === '') {
      setError('Pick an exercise.')
      return
    }

    const sets = Number.parseInt(targetSets.trim(), 10)
    if (!Number.isInteger(sets) || sets <= 0) {
      setError('Sets must be a whole number above zero.')
      return
    }

    if (targetReps.trim() === '') {
      setError('Reps are required. Anything goes: 8–10, AMRAP, RPE 8.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const created = await createPrescription(dayId, {
        exerciseId,
        targetSets: sets,
        targetReps: targetReps.trim(),
      })

      // The create response is a PrescriptionResponse — it carries exercise_id but not the
      // exercise itself, while the tree the screen is holding carries the whole thing. The
      // name is filled in from the library rather than left blank until a reload, since the
      // library is the same list the choice was just made from.
      const exercise = library.find((candidate) => candidate.id === exerciseId)
      onAdded({
        id: created.id,
        position: created.position,
        targetSets: created.targetSets,
        targetReps: created.targetReps,
        targetLoad: created.targetLoad,
        restSeconds: created.restSeconds,
        note: created.note,
        exercise: {
          id: exerciseId,
          name: exercise?.name ?? 'Exercise',
          videoUrl: exercise?.videoUrl ?? null,
          cues: exercise?.cues ?? null,
        },
      })

      setExerciseId('')
      setTargetReps('')
      setTargetSets('3')
    } catch (caught) {
      // 400 unknown_exercise is reachable even though the picker only offers active exercises:
      // the trainer may have retired one in another tab since this screen loaded. This is the
      // case the copy map exists for. The server can only say "Unknown exercise_id." because it
      // has no idea a stale picker offered it; the SPA drew that list, so the SPA is the layer
      // that can say the library moved on and a reload will show it.
      setError(messageFor(caught, 'prescription'))
    } finally {
      setSaving(false)
    }
  }

  if (library.length === 0) {
    // Nothing to pick, and now somewhere to send them: #55 built the library screen this used to
    // only be able to describe. A dead end on the one screen where a trainer discovers they have
    // no exercises is the worst place to leave one.
    return (
      <div className="mt-6 border-t border-edge pt-4">
        <p className="text-sm text-muted">
          Your exercise library is empty, so there is nothing to add yet.{' '}
          {/* A link inside a sentence, and the one place on these four screens where that is
              genuinely what it is: it goes somewhere, mid-prose, and a button in the middle of
              a paragraph would be the wrong object. Inherits the paragraph's size and --muted,
              which is why trainerLink sets neither. */}
          <Link className={trainerLink} to="/exercises">
            Add an exercise
          </Link>{' '}
          and then prescribe it here.
        </p>
      </div>
    )
  }

  return (
    <form className="mt-6 flex flex-wrap items-end gap-3 border-t border-edge pt-4" noValidate onSubmit={onSubmit}>
      <div className="grid gap-1">
        <label className="text-xs text-muted" htmlFor={`add-exercise-${dayId}`}>
          Exercise
        </label>
        {/* Only active exercises are options. #26 soft-deletes and the library route returns
            retired rows too, but #28 refuses one on a new prescription — an option that is
            always a 400 is not a choice, it is a trap. */}
        <select
          className={trainerField}
          id={`add-exercise-${dayId}`}
          name="exerciseId"
          onChange={(event) => {
            setExerciseId(event.target.value)
            edited()
          }}
          value={exerciseId}
        >
          <option value="">Choose one</option>
          {library.map((exercise) => (
            <option key={exercise.id} value={exercise.id}>
              {exercise.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-1">
        <label className="text-xs text-muted" htmlFor={`add-sets-${dayId}`}>
          Sets
        </label>
        <input
          className={`w-20 ${trainerField}`}
          id={`add-sets-${dayId}`}
          inputMode="numeric"
          min={1}
          name="targetSets"
          onChange={(event) => {
            setTargetSets(event.target.value)
            edited()
          }}
          type="number"
          value={targetSets}
        />
      </div>

      {/* Text, for the same reason the row editor's is (database.md). */}
      <div className="grid gap-1">
        <label className="text-xs text-muted" htmlFor={`add-reps-${dayId}`}>
          Reps
        </label>
        <input
          className={`w-32 ${trainerField}`}
          id={`add-reps-${dayId}`}
          name="targetReps"
          onChange={(event) => {
            setTargetReps(event.target.value)
            edited()
          }}
          placeholder="8–10"
          type="text"
          value={targetReps}
        />
      </div>

      <button className={trainerPrimary} disabled={saving} type="submit">
        {saving ? 'Adding' : 'Add exercise'}
      </button>

      {error !== null && (
        <TrainerMessage className="w-full" tone="failure">
          {error}
        </TrainerMessage>
      )}
    </form>
  )
}

function AddDay({
  onAdded,
  programId,
}: {
  onAdded: (day: { id?: string; title?: string | null; position?: number }) => void
  programId: string
}) {
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) {
      return
    }

    if (title.trim() === '') {
      setError('A day needs a name.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      onAdded(await createDay(programId, { title: title.trim() }))
      setTitle('')
    } catch (caught) {
      // 'program': the day does not exist yet, so a 404 is about the program being written to.
      setError(messageFor(caught, 'program'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="mt-6 flex flex-wrap items-end gap-3" noValidate onSubmit={onSubmit}>
      <div className="grid gap-2">
        <label className="text-sm font-semibold text-ink" htmlFor="new-day-title">
          Add a day
        </label>
        <input
          className={trainerField}
          id="new-day-title"
          name="title"
          onChange={(event) => {
            setTitle(event.target.value)
            setError(null)
          }}
          placeholder="Lower"
          value={title}
        />
      </div>
      <button className={trainerPrimary} disabled={saving} type="submit">
        {saving ? 'Adding' : 'Add day'}
      </button>
      {error !== null && (
        <TrainerMessage className="w-full" tone="failure">
          {error}
        </TrainerMessage>
      )}
    </form>
  )
}

function Field({
  children,
  label,
  name,
}: {
  children: React.ReactNode
  label: string
  name: string
}) {
  return (
    <div className="grid gap-1">
      <label className="text-xs text-muted" htmlFor={name}>
        {label}
      </label>
      {children}
    </div>
  )
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
