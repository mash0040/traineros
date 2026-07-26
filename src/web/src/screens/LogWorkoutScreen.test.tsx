import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MeProgramWrapper, MeResponse } from '../api/types.gen'
import { LogWorkoutScreen } from './LogWorkoutScreen'

const me: MeResponse = {
  id: 'client-1',
  displayName: 'Ada',
  email: 'ada@example.com',
  timezone: 'America/Toronto',
}

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
            exercise: { id: 'ex-1', name: 'Back Squat' },
          },
          {
            id: 'presc-2',
            position: 2,
            targetSets: 3,
            targetReps: '12',
            exercise: { id: 'ex-2', name: 'Leg Curl' },
          },
        ],
      },
      { id: 'day-2', title: 'Upper', position: 2, prescriptions: [] },
    ],
  },
}

const DRAFT_KEY = 'traineros.workout-draft.v1'

describe('LogWorkoutScreen', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** One mock for both routes the screen touches, so a test can assert what was sent where. */
  function mockApi(options: { createFails?: boolean; holdCreate?: Promise<void> } = {}) {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/me/program') {
        return { ok: true, status: 200, json: async () => program }
      }

      if (url === '/api/me/sessions') {
        // Lets a test keep the request in flight, which is the only way to reach the state
        // the disable-on-tap rule exists for.
        if (options.holdCreate !== undefined) {
          await options.holdCreate
        }

        if (options.createFails === true) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: { code: 'bad_request', message: 'performed_on is required.' } }),
          }
        }
        return { ok: true, status: 201, json: async () => ({ id: 'session-1' }) }
      }

      throw new Error(`unexpected request to ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function createdSessionBodies(fetchMock: ReturnType<typeof mockApi>) {
    return fetchMock.mock.calls
      .filter(([url]) => url === '/api/me/sessions')
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
  }

  function renderScreen(day: string | null = 'day-1') {
    const path = day === null ? '/workout' : `/workout?day=${day}`
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<LogWorkoutScreen me={me} />} path="/workout" />
          <Route element={<h1>Today</h1>} path="/" />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('shows the chosen day with each prescription read once, and marks where set logging lands', async () => {
    mockApi()
    renderScreen()

    expect(await screen.findByRole('heading', { name: 'Lower', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Back Squat', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Leg Curl', level: 2 })).toBeInTheDocument()

    // Rank 3 (DESIGN.md §Log row): the target appears once, in the block header. If a later
    // ticket repeats it per set row this count goes up, which is the collapse the doc forbids.
    expect(screen.getAllByText('3 × 8-10 · 70 kg · rest 90s')).toHaveLength(1)
    expect(screen.getByText('Brace before you unrack.')).toBeInTheDocument()

    // The seams #45 and #46 fill: one per exercise, so neither ticket has to invent an
    // attachment point. The `Last` label is the rank-2 empty state the doc already specifies.
    expect(screen.getAllByText('Set logging arrives here.')).toHaveLength(2)
    expect(screen.getAllByText('Last')).toHaveLength(2)
  })

  it('stamps performed_on from the client timezone rather than the browser clock', async () => {
    // 02:30 UTC on the 26th is 22:30 on the 25th in Toronto. A session stamped from the
    // browser's zone would file this workout under the wrong day, and PATCH /api/me/sets
    // measures its same-day edit window against users.timezone (api.md #32) — so the two
    // would disagree about whether a set logged seconds ago is still editable.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-07-26T02:30:00Z'))
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    const fetchMock = mockApi()
    renderScreen()

    await user.click(await screen.findByRole('button', { name: 'Finish workout' }))

    await waitFor(() => expect(createdSessionBodies(fetchMock)).toHaveLength(1))
    expect(createdSessionBodies(fetchMock)[0].performedOn).toBe('2026-07-25')
  })

  it('creates the session when the workout is finished, carrying the day and the note', async () => {
    // Decision 1: the row is written by finishing, not by starting. workout_sessions has no
    // status column, so its existence is the completion record — and POST is the only request
    // that accepts a comment, there being no PATCH for a session.
    const fetchMock = mockApi()
    renderScreen()

    await userEvent.type(
      await screen.findByLabelText('Note for your trainer'),
      'Shoulder tweaked on the last set.',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(createdSessionBodies(fetchMock)).toEqual([
      {
        performedOn: expect.any(String),
        programDayId: 'day-1',
        comment: 'Shoulder tweaked on the last set.',
      },
    ])
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('keeps the note when the tab is reopened mid-workout, and creates no second session', async () => {
    // Decision 2, and the reason it holds: her phone locks between sets and the tab is evicted.
    // Nothing was written on the way in, so returning cannot duplicate a row — workout_sessions
    // has no unique constraint, and this screen is the only thing standing between her and two
    // rows for one workout. What has to survive is the note, and it does.
    const fetchMock = mockApi()
    const first = renderScreen()

    await userEvent.type(await screen.findByLabelText('Note for your trainer'), 'Left knee felt off.')
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).toContain('Left knee felt off.'))
    first.unmount()

    renderScreen()

    expect(await screen.findByLabelText('Note for your trainer')).toHaveValue('Left knee felt off.')
    expect(screen.getByText('Your note from earlier is still here.')).toBeInTheDocument()
    // Arriving twice wrote nothing either time.
    expect(createdSessionBodies(fetchMock)).toHaveLength(0)
  })

  it('does not restore a note left over from a different workout', async () => {
    // Yesterday's draft, or another day of the program, is litter rather than a resume.
    // Restoring Tuesday's note into Thursday's workout would put words in her mouth.
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ performedOn: '2020-01-01', programDayId: 'day-1', comment: 'Old note.' }),
    )
    mockApi()
    renderScreen()

    expect(await screen.findByLabelText('Note for your trainer')).toHaveValue('')
    expect(screen.queryByText('Your note from earlier is still here.')).not.toBeInTheDocument()
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('keeps the note on the device when finishing fails', async () => {
    // The draft is cleared by a successful write and nothing else. Dropping it on the error
    // path would lose the note precisely when the client has to retype it.
    const fetchMock = mockApi({ createFails: true })
    renderScreen()

    await userEvent.type(await screen.findByLabelText('Note for your trainer'), 'Deload next week?')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('performed_on is required.')
    expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Note for your trainer')).toHaveValue('Deload next week?')
    expect(localStorage.getItem(DRAFT_KEY)).toContain('Deload next week?')
    // Still offered, because the failure may well be transient.
    expect(screen.getByRole('button', { name: 'Finish workout' })).toBeEnabled()
    expect(createdSessionBodies(fetchMock)).toHaveLength(1)
  })

  it('creates one session when Finish is tapped again before the first request answers', async () => {
    // api.md §Cross-cutting puts the mitigation for non-idempotent POSTs on the client, and
    // ui-ux.md makes it binding: "submit buttons disable-on-tap". A duplicate here is a
    // duplicate workout in the trainer's history.
    //
    // The request is held open deliberately. A first attempt at this test double-clicked
    // against an instantly-resolving mock and passed with both guards deleted — the screen had
    // already navigated away before the second click landed, so nothing was ever contended.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const fetchMock = mockApi({ holdCreate: held })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Finish workout' }))
    // Mid-flight: the button is still on screen, and tapping it again must do nothing.
    await userEvent.click(await screen.findByRole('button', { name: 'Saving' }))
    release()

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(createdSessionBodies(fetchMock)).toHaveLength(1)
  })

  it('offers a way back when the day is not in the active program', async () => {
    // A stale bookmark, or a program the trainer rebuilt since. Nothing is written and no
    // freestyle session is invented — v1 has no entry point for one.
    const fetchMock = mockApi()
    renderScreen('day-gone')

    expect(
      await screen.findByRole('heading', { name: 'That workout isn’t in your program' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to today' })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('button', { name: 'Finish workout' })).not.toBeInTheDocument()
    expect(createdSessionBodies(fetchMock)).toHaveLength(0)
  })

  it('offers a retry when the program cannot be loaded', async () => {
    // Same distinction Today draws: a dropped request is not an empty program, and it is
    // certainly not a missing day.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderScreen()

    expect(
      await screen.findByRole('heading', { name: 'We couldn’t load your workout' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'That workout isn’t in your program' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
