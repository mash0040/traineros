import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import type { DayView, MeProgramDetails, MeResponse, PrescriptionView } from '../api/types.gen'
import { fetchMyProgram } from '../lib/api'
import { targetLine } from '../lib/prescription'

type Load = 'loading' | 'ready' | 'unreachable'

// ui-ux.md §Client screens, Today. The screen a client opens standing in the gym, deciding
// what they are about to lift.
//
// What "current day" means here, resolved: nothing in the system knows which day is current.
// program_days carry a position and nothing else; no row records a rotation, and #38 settled
// the same question for the reminder email by naming the program rather than a day. So this
// screen does not guess. It shows the program's days as a choice and renders the one the
// client picks, defaulting to the first by position. Picking is one tap, and the client is the
// only party who knows whether today is legs or the day they skipped on Tuesday.
export function TodayScreen({ me }: { me: MeResponse }) {
  const [load, setLoad] = useState<Load>('loading')
  const [program, setProgram] = useState<MeProgramDetails | null>(null)
  const [chosenDayId, setChosenDayId] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoad('loading')

    fetchMyProgram()
      .then((wrapper) => {
        if (!cancelled) {
          // #30: `program` is an explicit null with a 200 when there is no active program.
          // That is an ordinary render path, so it lands in state like any other answer.
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

  // Both collections arrive ordered by position from the API, so there is no client-side sort
  // to drift out of step with the trainer's arrangement.
  const days = program?.days ?? []
  const day = days.find((candidate) => candidate.id === chosenDayId) ?? days[0] ?? null
  const prescriptions = day?.prescriptions ?? []

  return (
    <main className="flex min-h-dvh flex-col px-6 pt-10">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col">
        <p className="text-sm font-semibold tracking-wide text-muted">{me.displayName ?? 'TrainerOS'}</p>

        <h1 className="mt-8 text-xl font-semibold text-ink-bold">Today</h1>
        {program !== null && <p className="mt-1 text-sm text-muted">{program.title}</p>}

        {load === 'loading' ? (
          <ProgramSkeleton />
        ) : load === 'unreachable' ? (
          <Unreachable onRetry={() => setAttempt((previous) => previous + 1)} />
        ) : program === null ? (
          // Not an error state and not styled like one: a client whose trainer has not built
          // their program yet has nothing to fix.
          <Empty
            heading="No program yet"
            body="Your trainer builds it, and it shows up here."
          />
        ) : days.length === 0 ? (
          <Empty heading="This program has no days yet" body="Your trainer is still filling it in." />
        ) : (
          <>
            {days.length > 1 && (
              <DayPicker days={days} chosenId={day?.id ?? null} onChoose={setChosenDayId} />
            )}

            {/* With the picker on screen the selected tab already names the day, so a visible
                heading repeats it. It stays in the accessibility tree either way: the list
                below needs a heading, and with one day there is no tab to read instead. */}
            <h2
              className={
                days.length > 1 ? 'sr-only' : 'mt-8 text-lg font-semibold text-ink-bold'
              }
            >
              {day?.title}
            </h2>

            {prescriptions.length === 0 ? (
              <Empty heading="Nothing prescribed for this day" body="Pick another day, or check with your trainer." />
            ) : (
              // A divided list, not a stack of cards. DESIGN.md allows an exercise block as a
              // card on the logging screen, where the block owns inputs and is genuinely one
              // object; here each entry is a line of reference text, and eight identical
              // bordered cards is the grid the same doc bans.
              <ul className="mt-4 divide-y divide-edge">
                {prescriptions.map((prescription) => (
                  <Exercise key={prescription.id} prescription={prescription} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/* Sticky, shadowed, thumb-reachable: the one pattern DESIGN.md names for a primary CTA
          over scrolling content. Hidden when there is nothing to start, because a button that
          leads to an empty session is worse than no button. */}
      {prescriptions.length > 0 && day?.id !== undefined && (
        <div className="sticky bottom-0 -mx-6 mt-10 border-t border-edge bg-surface px-6 pb-8 pt-4 shadow-[var(--shadow-sticky)]">
          <Link
            className="mx-auto grid min-h-[var(--tap-min)] w-full max-w-lg place-items-center rounded-md bg-accent px-4 text-base font-semibold text-accent-ink hover:bg-accent-hover"
            to={`/workout?day=${day.id}`}
          >
            Start workout
          </Link>
        </div>
      )}
    </main>
  )
}

// Selecting which day you are doing. Deliberately not amber: DESIGN.md spends the accent on
// "the thing to tap" and there is exactly one of those per screen. Selection reads through
// weight, ink colour, and an underline instead.
function DayPicker({
  days,
  chosenId,
  onChoose,
}: {
  days: DayView[]
  chosenId: string | null
  onChoose: (id: string) => void
}) {
  return (
    <div className="-mx-6 mt-6 flex gap-1 overflow-x-auto px-6">
      {days.map((day) => {
        const chosen = day.id === chosenId
        return (
          <button
            aria-pressed={chosen}
            className={`min-h-[var(--tap-min)] shrink-0 border-b-2 px-3 text-sm whitespace-nowrap ${
              chosen ? 'border-edge-strong font-semibold text-ink-bold' : 'border-transparent text-muted'
            }`}
            key={day.id}
            onClick={() => day.id !== undefined && onChoose(day.id)}
            type="button"
          >
            {day.title}
          </button>
        )
      })}
    </div>
  )
}

function Exercise({ prescription }: { prescription: PrescriptionView }) {
  const exercise = prescription.exercise

  return (
    <li className="grid gap-1 py-6">
      <p className="text-base font-semibold text-ink-bold">{exercise?.name}</p>

      {/* Rank 3 (DESIGN.md §Log row): the prescription is read once, at the top of the
          exercise, in --text-sm / 400 / --muted. Never bolded, never repeated per set. */}
      <p className="text-sm text-muted">{targetLine(prescription)}</p>

      {/* The trainer's note for this prescription outranks the library cue: it was written
          about this exercise in this day, so it carries ink weight while the standing cue
          stays muted. */}
      {prescription.note !== null && prescription.note !== undefined && prescription.note !== '' && (
        <p className="text-sm text-ink">{prescription.note}</p>
      )}
      {exercise?.cues !== null && exercise?.cues !== undefined && exercise.cues !== '' && (
        <p className="text-sm text-muted">{exercise.cues}</p>
      )}

      {/* ui-ux.md: opens YouTube in a new tab, no embedded player. rel is not optional on a
          target=_blank link to a third-party origin.

          The label is underlined and the glyph is not: text-decoration inherits into children
          and cannot be cancelled there, so the rule lives on the label span. */}
      {exercise?.videoUrl !== null && exercise?.videoUrl !== undefined && exercise.videoUrl !== '' && (
        <a
          className="inline-flex min-h-[var(--tap-min)] items-center gap-1 text-sm font-semibold text-ink"
          href={exercise.videoUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          <span className="underline underline-offset-4">Watch demo</span>
          <span aria-hidden="true">&#8599;</span>
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      )}
    </li>
  )
}

function Empty({ heading, body }: { heading: string; body: string }) {
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
        <h2 className="text-lg font-semibold text-ink-bold">We couldn&rsquo;t load your program</h2>
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

// ui-ux.md asks for a skeleton on Today (the payload is a whole program, not one field).
// Static blocks, no shimmer: v1 has no motion vocabulary, and an animated skeleton would be
// the only moving thing in the app.
function ProgramSkeleton() {
  return (
    <div className="mt-8" role="status">
      <span className="sr-only">Loading your program</span>
      <div className="h-6 w-32 rounded-sm bg-surface-sunk" />
      <ul className="mt-4 divide-y divide-edge">
        {[0, 1, 2].map((row) => (
          <li className="grid gap-2 py-6" key={row}>
            <div className="h-5 w-44 rounded-sm bg-surface-sunk" />
            <div className="h-4 w-28 rounded-sm bg-surface-sunk" />
          </li>
        ))}
      </ul>
    </div>
  )
}
