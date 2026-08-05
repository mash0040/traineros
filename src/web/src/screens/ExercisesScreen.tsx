import { useEffect, useState } from 'react'

import type { ExerciseResponse } from '../api/types.gen'
import { ApiError, createExercise, fetchExercises, updateExercise } from '../lib/api'
import { TrainerShell } from './TrainerShell'
import {
  trainerDanger,
  trainerField,
  trainerPrimary,
  trainerQuiet,
  trainerSecondary,
} from './trainerControls'

type Load = 'loading' | 'ready' | 'unreachable'

// ui-ux.md §Trainer screens, Exercise library: "list/add/edit: name, video URL, cues;
// soft-delete". The second of the two top-level trainer destinations, which is why the nav bar
// in TrainerShell renders from this ticket onward — until now there was one screen and a bar
// pointing only at the page you were already on.
//
// ── Delete is a PATCH, and that is not an implementation detail ────────────────────────────
// #26 has no DELETE route. logged_sets.exercise_id is RESTRICT (database.md resolved question
// 1), so removing the row would either fail or take a client's history with it. Retiring sets
// is_active = false, which drops the exercise out of the program builder's picker while every
// prescription and every logged set that already names it carries on working.
//
// Two consequences the screen has to carry rather than hide:
//   * The list shows retired exercises. GET /api/exercises returns them deliberately so they
//     can be brought back, and a library that hid them would make "restore" unreachable.
//   * The confirmation says what retiring does and does not do. A trainer pressing something
//     called "Retire" on an exercise a client logged last week deserves to know the history is
//     not going anywhere — and equally, that programs already prescribing it keep it, which is
//     the part that would otherwise be a surprise.
//
// ── Server order, kept ─────────────────────────────────────────────────────────────────────
// The endpoint orders by name and this screen does not re-sort. Floating retired rows to the
// bottom was tempting and rejected: a trainer looking for a retired exercise looks for it by
// name, which is also how the picker they are comparing against is ordered. One order,
// everywhere, reproduced by a reload.
export function ExercisesScreen() {
  const [load, setLoad] = useState<Load>('loading')
  const [exercises, setExercises] = useState<ExerciseResponse[]>([])
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoad('loading')

    fetchExercises()
      .then((library) => {
        if (!cancelled) {
          setExercises(library)
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

  function onAdded(exercise: ExerciseResponse) {
    // Inserted in name order rather than appended, so the list a trainer is looking at is the
    // one a reload gives back. Same argument as the roster's.
    setExercises((previous) =>
      [...previous, exercise].sort((left, right) =>
        (left.name ?? '').localeCompare(right.name ?? ''),
      ),
    )
  }

  function onUpdated(exercise: ExerciseResponse) {
    setExercises((previous) =>
      previous
        .map((candidate) => (candidate.id === exercise.id ? exercise : candidate))
        // A rename moves the row, for the same reason an add lands in place.
        .sort((left, right) => (left.name ?? '').localeCompare(right.name ?? '')),
    )
  }

  return (
    <TrainerShell>
      <h1 className="text-xl font-semibold text-ink-bold">Exercise library</h1>
      <p className="mt-2 max-w-2xl text-base text-muted">
        Everything you can prescribe. Add one here, then pick it when you build a program.
      </p>

      {load === 'loading' ? (
        <p className="mt-8 text-base text-muted" role="status">
          Loading your exercises
        </p>
      ) : load === 'unreachable' ? (
        <div className="mt-8 grid justify-items-start gap-4">
          <div className="grid gap-2">
            <h2 className="text-lg font-semibold text-ink-bold">
              We couldn&rsquo;t load your exercises
            </h2>
            <p className="text-base text-muted">Check your connection and try again.</p>
          </div>
          <button
            className={trainerQuiet}
            onClick={() => setAttempt((previous) => previous + 1)}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {exercises.length === 0 ? (
            <p className="mt-8 text-base text-muted">
              No exercises yet. Add your first one below.
            </p>
          ) : (
            // Named, because the shell's nav is also a list: a screen reader jumping between
            // lists otherwise lands on two unlabelled ones and has to read into each to tell
            // which is the page.
            <ul aria-label="Your exercises" className="mt-8 grid gap-3">
              {exercises.map((exercise) => (
                <Exercise exercise={exercise} key={exercise.id} onUpdated={onUpdated} />
              ))}
            </ul>
          )}

          <AddExercise onAdded={onAdded} />
        </>
      )}
    </TrainerShell>
  )
}

// A list of rows, not a table. The roster is a table because it is parallel facts compared down
// a column; this is not that. Cues are prose of arbitrary length, the video is a link rather
// than a value, and the thing a trainer comes here to do is edit one row rather than compare
// forty. Wrapping paragraphs in table cells would be a grid fighting its own content.
//
// Each row reads first and edits on request. The builder's prescription rows are open forms
// because a day holds about five of them; a library holds as many exercises as a trainer has
// ever coached, and forty open forms is a wall rather than a list.
function Exercise({
  exercise,
  onUpdated,
}: {
  exercise: ExerciseResponse
  onUpdated: (exercise: ExerciseResponse) => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const active = exercise.isActive !== false
  const name = exercise.name ?? 'Exercise'

  async function setActive(isActive: boolean) {
    if (exercise.id === undefined || saving) {
      return
    }

    setSaving(true)
    setError(null)
    try {
      // Only isActive. Sending the text fields here as well would run them through #26's
      // blank-clears rule, so retiring an exercise with no cues written would silently be the
      // same request as clearing its cues — and one with cues would round-trip them for no
      // reason. See updateExercise's note.
      onUpdated(await updateExercise(exercise.id, { isActive }))
      setConfirming(false)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="rounded-sm border border-edge bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink-bold">
            {name}
            {!active && (
              // Beside the name rather than in a status column, because with no column to
              // compare down, the fact only means anything attached to the exercise it is about.
              <span className="ml-2 align-middle text-xs font-normal text-muted">Retired</span>
            )}
          </h2>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            aria-expanded={editing}
            className={trainerSecondary}
            onClick={() => {
              setEditing((previous) => !previous)
              setConfirming(false)
              setError(null)
            }}
            type="button"
          >
            {editing ? 'Close' : `Edit ${name}`}
          </button>

          {active ? (
            <button
              className={trainerSecondary}
              disabled={saving}
              onClick={() => setConfirming(true)}
              type="button"
            >
              Retire {name}
            </button>
          ) : (
            <button
              className={trainerSecondary}
              disabled={saving}
              onClick={() => void setActive(true)}
              type="button"
            >
              {saving ? 'Restoring' : `Restore ${name}`}
            </button>
          )}
        </div>
      </div>

      <Details exercise={exercise} />

      {confirming && (
        // Inline, replacing nothing and pushing nothing over: DESIGN.md calls the modal the lazy
        // first answer, and #50 settled the same question for the roster's deactivate.
        //
        // The wording is the whole reason this is a confirmation rather than a plain button. The
        // word "retire" does not tell a trainer which of three things happens to work already
        // done, so the prompt says all three: gone from the picker, kept where it is already
        // prescribed, and history untouched.
        <div className="mt-4 grid justify-items-start gap-2 border-t border-edge pt-4" role="group">
          <p className="text-sm text-ink-bold">Retire {name}?</p>
          <p className="max-w-2xl text-sm text-muted">
            You won&rsquo;t be able to add it to a program any more. Programs already using it
            keep it, and logged sets stay exactly as they are. You can restore it later.
          </p>
          <div className="flex gap-2">
            <button
              className={trainerDanger}
              disabled={saving}
              onClick={() => void setActive(false)}
              type="button"
            >
              {saving ? 'Retiring' : 'Retire'}
            </button>
            <button
              className={trainerPrimary}
              onClick={() => {
                setConfirming(false)
                setError(null)
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {editing && (
        <EditExercise
          exercise={exercise}
          onSaved={(updated) => {
            onUpdated(updated)
            setEditing(false)
          }}
        />
      )}

      {error !== null && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

// The read view: what the trainer sees before deciding to edit anything, and the only place the
// video URL is exercised as a link rather than as a string in a field.
function Details({ exercise }: { exercise: ExerciseResponse }) {
  const cues = exercise.cues ?? ''
  const videoUrl = exercise.videoUrl ?? ''

  if (cues === '' && videoUrl === '') {
    return null
  }

  return (
    <div className="mt-2 grid justify-items-start gap-2">
      {cues !== '' && <p className="max-w-2xl text-sm text-muted">{cues}</p>}

      {/* ui-ux.md: "Video links open YouTube in a new tab/native app. No embedded player (embed
          = layout shift + bundle weight for zero logging value)." That rule is about the
          client's Today screen and it holds here for a stronger reason: this screen is where a
          trainer checks the link is the one they meant, and an iframe proves nothing about
          where the href points.

          rel is not optional on a target=_blank link to a third-party origin. Same treatment as
          TodayScreen's, minus the 44px tap target — DESIGN.md relaxes that here. */}
      {videoUrl !== '' && (
        <a
          className="inline-flex items-center gap-1 text-sm font-semibold text-ink"
          href={videoUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          <span className="underline underline-offset-4">Watch demo</span>
          <span aria-hidden="true">&#8599;</span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      )}
    </div>
  )
}

function EditExercise({
  exercise,
  onSaved,
}: {
  exercise: ExerciseResponse
  onSaved: (exercise: ExerciseResponse) => void
}) {
  const [name, setName] = useState(exercise.name ?? '')
  const [videoUrl, setVideoUrl] = useState(exercise.videoUrl ?? '')
  const [cues, setCues] = useState(exercise.cues ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ message: string; field: Field | null } | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || exercise.id === undefined) {
      return
    }

    const problem = validate({ name, videoUrl })
    if (problem !== null) {
      setError(problem)
      return
    }

    setSaving(true)
    setError(null)
    try {
      // Every field this form owns, every time, including the empty ones. That is what makes
      // clearing possible at all: #26 reads "" as "set this to NULL", so a trainer who deletes
      // the contents of the video field and saves gets the link removed. Omitting empties would
      // make the field one-way.
      onSaved(
        await updateExercise(exercise.id, {
          name: name.trim(),
          videoUrl: videoUrl.trim(),
          cues: cues.trim(),
        }),
      )
    } catch (caught) {
      setError({
        message: caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.',
        field: null,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="mt-4 grid max-w-xl gap-4 border-t border-edge pt-4" noValidate onSubmit={onSubmit}>
      <Fields
        cues={cues}
        error={error}
        idPrefix={`exercise-${exercise.id}`}
        name={name}
        onCues={(value) => {
          setCues(value)
          setError(null)
        }}
        onName={(value) => {
          setName(value)
          setError(null)
        }}
        onVideoUrl={(value) => {
          setVideoUrl(value)
          setError(null)
        }}
        videoUrl={videoUrl}
      />

      {error !== null && (
        <p className="text-sm text-danger" id={`exercise-${exercise.id}-error`} role="alert">
          {error.message}
        </p>
      )}

      <button className={`justify-self-start ${trainerPrimary}`} disabled={saving} type="submit">
        {saving ? 'Saving' : 'Save changes'}
      </button>
    </form>
  )
}

// Behind a disclosure, below the list. The library is read far more often than it is added to —
// a trainer builds it once and then prescribes from it for months — so the list is the subject
// of the screen and the form is a thing you go and get. Progressive, not a modal, which is
// DESIGN.md's preferred order and the shape #50 already landed for adding a client.
function AddExercise({ onAdded }: { onAdded: (exercise: ExerciseResponse) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [cues, setCues] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ message: string; field: Field | null } | null>(null)
  const [addedName, setAddedName] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) {
      return
    }

    const problem = validate({ name, videoUrl })
    if (problem !== null) {
      setError(problem)
      setAddedName(null)
      return
    }

    setSaving(true)
    setError(null)
    try {
      const created = await createExercise({
        name: name.trim(),
        videoUrl: videoUrl.trim(),
        cues: cues.trim(),
      })
      onAdded(created)
      setAddedName(created.name ?? name.trim())
      // Cleared so the form is ready for the next one. A trainer setting the library up is
      // adding several in a row, which is the case worth optimising for.
      setName('')
      setVideoUrl('')
      setCues('')
    } catch (caught) {
      setError({
        message: caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.',
        field: null,
      })
      setAddedName(null)
    } finally {
      setSaving(false)
    }
  }

  // One toggle outside the form, one submit inside it — #114's ruling on the add-client form,
  // for the same reason: closing is dismissal, not completion, and a footer button beside "Add"
  // reads as a second way to finish.
  const toggle = (
    <button
      aria-expanded={open}
      className={`mt-8 ${trainerSecondary}`}
      onClick={() => {
        setOpen((previous) => !previous)
        setError(null)
        setAddedName(null)
      }}
      type="button"
    >
      {open ? 'Close' : 'Add an exercise'}
    </button>
  )

  if (!open) {
    return toggle
  }

  return (
    <>
      {toggle}
      <section className="mt-8 max-w-xl rounded-md border border-edge p-6">
        <h2 className="text-lg font-semibold text-ink-bold">Add an exercise</h2>

        <form className="mt-6 grid gap-4" noValidate onSubmit={onSubmit}>
          <Fields
            cues={cues}
            error={error}
            idPrefix="new-exercise"
            name={name}
            onCues={(value) => {
              setCues(value)
              setError(null)
              setAddedName(null)
            }}
            onName={(value) => {
              setName(value)
              setError(null)
              setAddedName(null)
            }}
            onVideoUrl={(value) => {
              setVideoUrl(value)
              setError(null)
              setAddedName(null)
            }}
            videoUrl={videoUrl}
          />

          {error !== null && (
            <p className="text-sm text-danger" id="new-exercise-error" role="alert">
              {error.message}
            </p>
          )}

          {addedName !== null && error === null && (
            <p className="text-sm text-ink" role="status">
              {addedName} added. You can prescribe it now.
            </p>
          )}

          <button className={`justify-self-start ${trainerPrimary}`} disabled={saving} type="submit">
            {saving ? 'Adding' : 'Add exercise'}
          </button>
        </form>
      </section>
    </>
  )
}

type Field = 'name' | 'videoUrl'

// The three inputs, shared by both forms so the add and the edit cannot drift into asking for
// the same three things in two different ways.
function Fields({
  cues,
  error,
  idPrefix,
  name,
  onCues,
  onName,
  onVideoUrl,
  videoUrl,
}: {
  cues: string
  error: { message: string; field: Field | null } | null
  idPrefix: string
  name: string
  onCues: (value: string) => void
  onName: (value: string) => void
  onVideoUrl: (value: string) => void
  videoUrl: string
}) {
  // Points the description at the message only for the field it is about. A single error string
  // marking every input aria-invalid sends a screen reader user to fix what is already right —
  // the defect #114 found on the add-client form.
  const describedBy = (field: Field) =>
    error?.field === field ? `${idPrefix}-error` : undefined

  return (
    <>
      <div className="grid gap-2">
        <label className="text-sm font-semibold text-ink" htmlFor={`${idPrefix}-name`}>
          Name
        </label>
        <input
          aria-describedby={describedBy('name')}
          aria-invalid={error?.field === 'name'}
          className={trainerField}
          id={`${idPrefix}-name`}
          name="name"
          onChange={(event) => onName(event.target.value)}
          placeholder="Back Squat"
          value={name}
        />
      </div>

      <div className="grid gap-2">
        <label className="text-sm font-semibold text-ink" htmlFor={`${idPrefix}-video`}>
          Video URL
        </label>
        <input
          aria-describedby={describedBy('videoUrl')}
          aria-invalid={error?.field === 'videoUrl'}
          autoCapitalize="none"
          className={trainerField}
          id={`${idPrefix}-video`}
          inputMode="url"
          name="videoUrl"
          onChange={(event) => onVideoUrl(event.target.value)}
          placeholder="https://www.youtube.com/watch?v=..."
          spellCheck={false}
          value={videoUrl}
        />
        <p className="text-xs text-muted">
          Optional. Opens in a new tab when your client taps it.
        </p>
      </div>

      <div className="grid gap-2">
        <label className="text-sm font-semibold text-ink" htmlFor={`${idPrefix}-cues`}>
          Cues
        </label>
        {/* A textarea, not an input. Cues are the coaching sentence a client reads mid-set —
            "chest up, knees out" — and a one-line field that scrolls sideways hides the end of
            what was typed at exactly the moment it is being checked. */}
        <textarea
          className={trainerField}
          id={`${idPrefix}-cues`}
          name="cues"
          onChange={(event) => onCues(event.target.value)}
          placeholder="Chest up, knees out, drive through mid-foot."
          rows={3}
          value={cues}
        />
        <p className="text-xs text-muted">Optional. Shown to your client under the exercise.</p>
      </div>
    </>
  )
}

/**
 * The one rule both forms apply before sending, or null when there is nothing to say.
 *
 * Name is required because the server requires it; checking here turns a round trip into an
 * instant answer, and the wording matches what a person would want to read rather than
 * "name is required."
 *
 * The video URL is checked for something the server does not check at all: that it is an
 * absolute http(s) URL. A bare "youtube.com/watch?v=x" is stored happily and then rendered as
 * an href, where the browser reads it as a relative path — so the client taps "Watch demo" and
 * lands inside the app on a route that does not exist, rather than on YouTube. That is a defect
 * the trainer cannot see from this screen and the client cannot report usefully.
 *
 * Deliberately not restricted to YouTube hosts. ui-ux.md describes where these links go, not
 * what the field accepts, and a trainer with a Vimeo link or a video they host themselves has
 * done nothing wrong. The scheme check is about the link working at all; the host is theirs.
 *
 * Also deliberately not auto-prefixing "https://" onto a bare host. It is a guess about what
 * someone meant, it is silent, and when it is wrong the trainer sees a URL they did not type.
 */
function validate({
  name,
  videoUrl,
}: {
  name: string
  videoUrl: string
}): { message: string; field: Field } | null {
  if (name.trim() === '') {
    return { message: 'Give the exercise a name.', field: 'name' }
  }

  const url = videoUrl.trim()
  if (url !== '' && !isHttpUrl(url)) {
    return {
      message: 'Enter a full link starting with https://, or leave it empty.',
      field: 'videoUrl',
    }
  }

  return null
}

function isHttpUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    // Relative, or not a URL at all. Either way it cannot be handed to an href.
    return false
  }

  // A parseable URL is not enough: "javascript:alert(1)" parses, and so does "mailto:me". This
  // value ends up as an href the client taps, so the two schemes that mean "fetch a page over
  // the network" are the two that are allowed.
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}
