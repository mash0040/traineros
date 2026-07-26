import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MeProgramWrapper } from '../api/types.gen'
import { TodayScreen } from './TodayScreen'

const me = { id: 'client-1', displayName: 'Ada', email: 'ada@example.com', timezone: 'America/Toronto' }

const program: MeProgramWrapper = {
  program: {
    id: 'program-1',
    title: 'Winter Block',
    status: 'active',
    days: [
      {
        id: 'day-1',
        title: 'Lower',
        position: 1,
        prescriptions: [
          {
            id: 'presc-1',
            position: 1,
            targetSets: 3,
            targetReps: '8-10',
            targetLoad: '70 kg',
            restSeconds: 90,
            note: 'Brace before you unrack.',
            exercise: {
              id: 'ex-1',
              name: 'Back Squat',
              videoUrl: 'https://youtube.com/watch?v=squat',
              cues: 'Knees track over toes.',
            },
          },
        ],
      },
      {
        id: 'day-2',
        title: 'Upper',
        position: 2,
        prescriptions: [
          {
            id: 'presc-2',
            position: 1,
            targetSets: 4,
            targetReps: '5',
            exercise: { id: 'ex-2', name: 'Bench Press' },
          },
        ],
      },
    ],
  },
}

describe('TodayScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockProgram(body: MeProgramWrapper) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }),
    )
  }

  function renderScreen() {
    return render(
      <MemoryRouter>
        <TodayScreen me={me} />
      </MemoryRouter>,
    )
  }

  it('renders the first day with its targets, cues, and video link', async () => {
    mockProgram(program)
    renderScreen()

    expect(await screen.findByRole('heading', { name: 'Lower', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('Back Squat')).toBeInTheDocument()
    // Target reads once, as one line: sets × reps, load, rest.
    expect(screen.getByText('3 × 8-10 · 70 kg · rest 90s')).toBeInTheDocument()
    expect(screen.getByText('Brace before you unrack.')).toBeInTheDocument()
    expect(screen.getByText('Knees track over toes.')).toBeInTheDocument()

    // ui-ux.md: YouTube opens in a new tab, and a cross-origin target=_blank needs rel.
    const video = screen.getByRole('link', { name: /Watch demo/ })
    expect(video).toHaveAttribute('href', 'https://youtube.com/watch?v=squat')
    expect(video).toHaveAttribute('target', '_blank')
    expect(video).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('lets the client choose the day instead of guessing one for them', async () => {
    // The decision this screen rests on: nothing knows which day is "today", so switching is
    // the client's call and both days are one tap away.
    mockProgram(program)
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Upper' }))

    expect(screen.getByRole('heading', { name: 'Upper', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('Bench Press')).toBeInTheDocument()
    expect(screen.queryByText('Back Squat')).not.toBeInTheDocument()
    // A prescription with no load or rest shows fewer facts, not empty ones.
    expect(screen.getByText('4 × 5')).toBeInTheDocument()
  })

  it('treats "no active program" as an empty state, not an error', async () => {
    // api.md #30: 200 with program: null. Rendering an error here would tell the client
    // something is broken when their trainer simply has not built the program yet.
    mockProgram({ program: undefined })
    renderScreen()

    expect(await screen.findByRole('heading', { name: 'No program yet', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Start workout' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('starts a workout for the chosen day', async () => {
    mockProgram(program)
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Upper' }))

    expect(screen.getByRole('link', { name: 'Start workout' })).toHaveAttribute(
      'href',
      '/workout?day=day-2',
    )
  })

  it('offers a retry when the program cannot be loaded', async () => {
    // Same distinction the verify screen draws: a dropped request is not an empty program.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderScreen()

    expect(
      await screen.findByRole('heading', { name: 'We couldn’t load your program', level: 2 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No program yet' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('keeps the day name as a heading when the picker takes over naming it', async () => {
    // From the browser pass: the day title rendered twice, once as the selected tab and once
    // as a heading. The fix hid the heading rather than dropping it, because the exercise list
    // still needs one and a single-day program has no tab to read instead.
    //
    // This pins the behavioural half only. Whether the title is *visibly* duplicated is CSS,
    // and jsdom loads no stylesheet, so a test here cannot tell the two states apart without
    // asserting a class name. The visual half is a layout-pass question.
    mockProgram(program)
    renderScreen()

    expect(await screen.findByRole('heading', { name: 'Lower', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Lower', pressed: true })).toBeInTheDocument()
  })

  it('hides the day picker when the program has a single day', async () => {
    mockProgram({ program: { ...program.program, days: [program.program!.days![0]] } })
    renderScreen()

    expect(await screen.findByRole('heading', { name: 'Lower', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Lower' })).not.toBeInTheDocument()
  })
})
