import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { ApiError, createProgram } from '../lib/api'
import { messageFor } from '../lib/apiMessages'
import { useBlockMessage } from './blockMessage'
import { Message } from './Message'
import { TrainerShell } from './TrainerShell'
import { trainerField, trainerLink, trainerPrimary } from './trainerControls'

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

  const block = useBlockMessage('new-program-message')

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) {
      return
    }

    if (title.trim() === '') {
      block.fail('Give the program a name.')
      return
    }

    setSaving(true)
    block.clear()
    try {
      const created = await createProgram({ clientId, title: title.trim() })
      if (created.id === undefined) {
        throw new ApiError(0, 'unknown', 'Something went wrong. Try again.')
      }

      // `replace`, so Back from the builder returns to the client rather than to a form that
      // would create a second program if it were submitted again.
      navigate(`/programs/${created.id}`, { replace: true })
    } catch (caught) {
      block.fail(messageFor(caught, 'program'))
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
        <Link className={`mt-6 inline-block text-base text-ink ${trainerLink}`} to="/clients">
          Back to clients
        </Link>
      </TrainerShell>
    )
  }

  return (
    <TrainerShell>
      <Link className={`text-sm text-muted ${trainerLink}`} to={`/clients/${clientId}`}>
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
            aria-describedby={block.describedBy}
            aria-invalid={block.message !== null}
            className={trainerField}
            id="program-title"
            name="title"
            onChange={(event) => {
              setTitle(event.target.value)
              // Goes as soon as the trainer starts fixing what it named, rather than standing
              // there describing a submission they have already moved past.
              block.clear()
            }}
            placeholder="Winter Block"
            value={title}
          />
        </div>

        {block.message !== null && (
          <Message id={block.id} tone={block.message.tone}>
            {block.message.body}
          </Message>
        )}

        <button
          aria-describedby={block.describedBy}
          className={`justify-self-start ${trainerPrimary}`}
          disabled={saving}
          type="submit"
        >
          {saving ? 'Creating' : 'Create program'}
        </button>
      </form>
    </TrainerShell>
  )
}
