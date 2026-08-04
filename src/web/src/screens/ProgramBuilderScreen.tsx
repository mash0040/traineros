import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import type { DayView, PrescriptionView, ProgramDetailResponse } from '../api/types.gen'
import {
  ApiError,
  createDay,
  deleteDay,
  deletePrescription,
  fetchProgram,
  updateDay,
  updatePrescription,
  updateProgram,
} from '../lib/api'
import { TrainerShell } from './TrainerShell'
import { trainerDanger, trainerField, trainerPrimary, trainerQuiet, trainerSecondary } from './trainerControls'

type Load = 'loading' | 'ready' | 'missing' | 'unreachable'

const STATUSES = ['draft', 'active', 'archived']

// ui-ux.md §Trainer screens, Program builder: "days → prescriptions; add exercise from library;
// drag-or-buttons reorder". #53 builds the day and prescription editing; the exercise picker and
// the reordering are #54 and are marked below rather than half-built.
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
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoad('loading')

    fetchProgram(programId)
      .then((tree) => {
        if (!cancelled) {
          setProgram(tree)
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
        <Link className={`mt-6 inline-block ${trainerQuiet}`} to="/clients">
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
        <button
          className={`mt-6 ${trainerQuiet}`}
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
        <Link className={`text-sm text-muted ${trainerQuiet}`} to={`/clients/${program.clientId}`}>
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
      // The server's message names the conflict; this adds the part the trainer has to do
      // about it, which the API has no business knowing.
      setAttempt({
        status: next,
        message:
          caught instanceof ApiError && caught.code === 'program_active_conflict'
            ? `${caught.message} Archive that one first, then activate this.`
            : caught instanceof ApiError
              ? caught.message
              : 'Something went wrong. Try again.',
      })
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2" role="group" aria-label="Program status">
        {STATUSES.map((candidate) => {
          const current = candidate === status
          return (
            <button
              aria-pressed={current}
              className={current ? trainerPrimary : trainerSecondary}
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
        <p className="mt-2 text-sm text-danger" role="alert">
          {conflict}
        </p>
      )}
    </div>
  )
}

function Day({
  day,
  onChanged,
  onDeleted,
}: {
  day: DayView
  onChanged: (day: DayView) => void
  onDeleted: () => void
}) {
  const [title, setTitle] = useState(day.title ?? '')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const prescriptions = day.prescriptions ?? []

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
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
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
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
      setDeleting(false)
    }
  }

  return (
    <li className="rounded-md border border-edge p-6">
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
        <button className={trainerSecondary} disabled={saving} type="submit">
          {saving ? 'Saving' : 'Save name'}
        </button>
      </form>

      {error !== null && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <ul className="mt-6 grid gap-4">
        {prescriptions.length === 0 ? (
          <p className="text-base text-muted">Nothing prescribed on this day yet.</p>
        ) : (
          prescriptions.map((prescription) => (
            <Prescription
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
              prescription={prescription}
            />
          ))
        )}
      </ul>

      {/* ── #54 lands here ────────────────────────────────────────────────────────────────
          Adding a prescription needs an exercise_id, and choosing one from the trainer's
          library is the picker this ticket is told not to build. So the control is present,
          disabled, and says what it is waiting for — rather than a half-picker that would have
          to be thrown away, or nothing at all, which would read as a screen that forgot to let
          you add exercises.

          Reordering (#54 as well) attaches to the same seam: PATCH /api/days/:id/order takes
          the full ordered id list, which is a control over this list, not inside a row. */}
      <div className="mt-6 border-t border-edge pt-4">
        <button className={trainerSecondary} disabled title="The exercise picker arrives in #54" type="button">
          Add exercise
        </button>
        <p className="mt-2 text-xs text-muted">
          Picking an exercise and reordering this list arrive with the exercise library work.
        </p>
      </div>

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
              <button className={trainerPrimary} onClick={() => setConfirming(false)} type="button">
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
  onChanged,
  onDeleted,
  prescription,
}: {
  onChanged: (prescription: PrescriptionView) => void
  onDeleted: () => void
  prescription: PrescriptionView
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
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
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
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
      setDeleting(false)
    }
  }

  return (
    <li className="rounded-sm border border-edge bg-surface-sunk p-4">
      <h3 className="text-base font-semibold text-ink-bold">{name}</h3>

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
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        {saved && error === null && (
          <p className="text-sm text-ink" role="status">
            Saved.
          </p>
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
            <button className={trainerSecondary} onClick={() => setConfirming(true)} type="button">
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
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
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
        <p className="w-full text-sm text-danger" role="alert">
          {error}
        </p>
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
