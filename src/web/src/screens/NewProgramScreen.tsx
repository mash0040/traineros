import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { ApiError, createProgram } from '../lib/api'
import { TrainerShell } from './TrainerShell'
import { trainerField, trainerPrimary, trainerQuiet } from './trainerControls'

// The other half of #51's handoff. That screen links here as /programs/new?client=<id> from a
// client who has no program yet, and this is the smallest thing that turns that link into a
// program the builder can open.
//
// Deliberately not a second builder: it takes a title, creates the row, and navigates into
// /programs/:id, where days and prescriptions are edited. Status is left at the server's
// default of draft — #27 makes every transition available from the builder, and a program that
// went live the moment it was named, before it had a single day in it, would be a reminder
// email pointing at nothing.
export function NewProgramScreen() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const clientId = params.get('client') ?? ''

  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) {
      return
    }

    if (title.trim() === '') {
      setError('Give the program a name.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const created = await createProgram({ clientId, title: title.trim() })
      if (created.id === undefined) {
        throw new ApiError(0, 'unknown', 'Something went wrong. Try again.')
      }

      // `replace`, so Back from the builder returns to the client rather than to a form that
      // would create a second program if it were submitted again.
      navigate(`/programs/${created.id}`, { replace: true })
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
      setSaving(false)
    }
  }

  // Reached without a client id — a hand-typed URL, or a stale link. POST /api/programs would
  // answer 400, but there is nothing on this screen to fix it with, since a program belongs to
  // a client and this form has no way to pick one. The roster does.
  if (clientId === '') {
    return (
      <TrainerShell>
        <h1 className="text-xl font-semibold text-ink-bold">Pick a client first</h1>
        <p className="mt-2 text-base text-muted">
          A program belongs to one client. Open theirs and start it from there.
        </p>
        <Link className={`mt-6 inline-block ${trainerQuiet}`} to="/clients">
          Back to clients
        </Link>
      </TrainerShell>
    )
  }

  return (
    <TrainerShell>
      <Link className={`text-sm text-muted ${trainerQuiet}`} to={`/clients/${clientId}`}>
        Back to client
      </Link>

      <h1 className="mt-4 text-xl font-semibold text-ink-bold">New program</h1>
      <p className="mt-2 text-base text-muted">
        It starts as a draft. Add days and exercises, then activate it when it&rsquo;s ready.
      </p>

      <form className="mt-6 grid max-w-md gap-4" noValidate onSubmit={onSubmit}>
        <div className="grid gap-2">
          <label className="text-sm font-semibold text-ink" htmlFor="program-title">
            Name
          </label>
          <input
            aria-describedby={error === null ? undefined : 'new-program-error'}
            aria-invalid={error !== null}
            className={trainerField}
            id="program-title"
            name="title"
            onChange={(event) => {
              setTitle(event.target.value)
              // Goes as soon as the trainer starts fixing what it named, rather than standing
              // there describing a submission they have already moved past.
              setError(null)
            }}
            placeholder="Winter Block"
            value={title}
          />
        </div>

        {error !== null && (
          <p className="text-sm text-danger" id="new-program-error" role="alert">
            {error}
          </p>
        )}

        <button className={`justify-self-start ${trainerPrimary}`} disabled={saving} type="submit">
          {saving ? 'Creating' : 'Create program'}
        </button>
      </form>
    </TrainerShell>
  )
}
