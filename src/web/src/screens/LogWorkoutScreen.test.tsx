import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HistoryResponse, LastResponse, MeProgramWrapper, MeResponse } from '../api/types.gen'
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
const SESSION_ID = 'session-1'

type Reply = { ok: boolean; status: number; body: unknown } | 'network'

function ok(body: unknown, status = 200): Reply {
  return { ok: true, status, body }
}

function rejected(status: number, code: string, message: string): Reply {
  return { ok: false, status, body: { error: { code, message } } }
}

describe('LogWorkoutScreen', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** One mock for every route the screen touches, recording what went where. */
  function mockApi(
    options: {
      history?: HistoryResponse
      holdCreate?: Promise<void>
      holdLast?: Promise<void>
      last?: Record<string, LastResponse>
      onCreateSession?: (attempt: number) => Reply
      onDeleteSet?: (url: string) => Reply
      onLast?: (exerciseId: string) => Reply
      onLogSet?: (attempt: number) => Reply
      onPatch?: (attempt: number) => Reply
      program?: MeProgramWrapper
    } = {},
  ) {
    let creates = 0
    let sets = 0
    let patches = 0

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))

      const send = (reply: Reply) => {
        if (reply === 'network') {
          // What fetch does when it never reaches the server; api.ts turns it into status 0.
          throw new TypeError('Failed to fetch')
        }
        return { ok: reply.ok, status: reply.status, json: async () => reply.body }
      }

      if (url === '/api/me/program') {
        return send(ok(options.program ?? program))
      }

      if (url.startsWith('/api/me/history')) {
        return send(ok(options.history ?? { items: [], nextCursor: null }))
      }

      if (url.startsWith('/api/me/last')) {
        const exerciseId = new URL(url, 'http://test').searchParams.get('exercise_id') ?? ''
        if (options.holdLast !== undefined) {
          await options.holdLast
        }
        if (options.onLast !== undefined) {
          return send(options.onLast(exerciseId))
        }
        return send(ok(options.last?.[exerciseId] ?? { mostRecent: null }))
      }

      if (url === '/api/me/sessions' && method === 'POST') {
        creates += 1
        if (options.holdCreate !== undefined) {
          await options.holdCreate
        }
        return send(options.onCreateSession?.(creates) ?? ok({ id: SESSION_ID }, 201))
      }

      if (url.endsWith('/sets') && method === 'POST') {
        sets += 1
        const reply =
          options.onLogSet?.(sets) ??
          ok(
            {
              id: `set-${sets}`,
              setNumber: body.setNumber,
              weightKg: body.weightKg,
              reps: body.reps,
            },
            201,
          )
        return send(reply)
      }

      if (method === 'DELETE') {
        return send(options.onDeleteSet?.(url) ?? { ok: true, status: 204, body: null })
      }

      if (method === 'PATCH') {
        patches += 1
        return send(options.onPatch?.(patches) ?? ok({ id: SESSION_ID, comment: body.comment }))
      }

      throw new Error(`unexpected ${method} ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  type Call = { method: string; url: string; body: Record<string, unknown> }

  function callsTo(fetchMock: ReturnType<typeof mockApi>, method: string, match: RegExp): Call[] {
    return fetchMock.mock.calls
      .map(([url, init]) => ({
        method: (init as RequestInit | undefined)?.method ?? 'GET',
        url: String(url),
        body:
          (init as RequestInit | undefined)?.body === undefined
            ? {}
            : (JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>),
      }))
      .filter((call) => call.method === method && match.test(call.url))
  }

  const sessionPosts = (f: ReturnType<typeof mockApi>) => callsTo(f, 'POST', /^\/api\/me\/sessions$/)
  const setPosts = (f: ReturnType<typeof mockApi>) => callsTo(f, 'POST', /\/sets$/)
  const patches = (f: ReturnType<typeof mockApi>) => callsTo(f, 'PATCH', /\/api\/me\/sessions\//)

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

  /** Scopes to one exercise card — every block carries identically-worded controls. */
  async function block(name: string) {
    return within(await screen.findByRole('listitem', { name }))
  }

  async function logSet(name: string, weight: string, reps: string) {
    const card = await block(name)
    const save = card.getByRole('button', { name: /Save set|Try again/ })
    if (weight !== '') {
      await userEvent.type(card.getByLabelText(new RegExp(`${name} set \\d+ weight`)), weight)
    }
    await userEvent.type(card.getByLabelText(new RegExp(`${name} set \\d+ reps`)), reps)
    await userEvent.click(save)
  }

  // -- Scaffold that #47 left, still holding --

  it('shows the chosen day with each prescription read once, and the last-time column untouched', async () => {
    mockApi()
    renderScreen()

    expect(await screen.findByRole('heading', { name: 'Lower', level: 1 })).toBeInTheDocument()

    // Rank 3 (DESIGN.md §Log row): the target appears once, in the block header. Repeating it
    // per set row is the collapse the doc forbids.
    expect(screen.getAllByText('3 × 8-10 · 70 kg · rest 90s')).toHaveLength(1)

    // Rank 2 with no history to show: the column is named once by its header and every cell
    // holds a dash.
    const squat = await block('Back Squat')
    expect(squat.getAllByText('Last', { exact: true })).toHaveLength(1)
    expect(squat.getByText('–')).toBeInTheDocument()
  })

  it('gives the inputs the keyboards ui-ux.md requires', async () => {
    // "inputmode=decimal / numeric on weight/reps — never a full keyboard for numbers." A
    // number pad is the difference between logging a set in three seconds and fifteen.
    mockApi()
    renderScreen()
    const squat = await block('Back Squat')

    expect(squat.getByLabelText(/weight in kilograms/)).toHaveAttribute('inputmode', 'decimal')
    expect(squat.getByLabelText(/reps/)).toHaveAttribute('inputmode', 'numeric')
  })

  // -- Inline last-time (#46) --

  const squatLast: LastResponse = {
    mostRecent: {
      sessionId: 'session-last-week',
      performedOn: '2026-07-19',
      exercise: { id: 'ex-1', name: 'Back Squat' },
      sets: [
        { id: 'a', setNumber: 1, weightKg: 72.5, reps: 8, loggedAt: '2026-07-19T12:00:00Z' },
        { id: 'b', setNumber: 2, weightKg: 75, reps: 6, loggedAt: '2026-07-19T12:05:00Z' },
      ],
    },
  }

  const lastRequests = (fetchMock: ReturnType<typeof mockApi>) =>
    fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/me/last'))

  /**
   * The last-time cells of one exercise, top to bottom — the vertical strip DESIGN.md asks for.
   *
   * Found by each cell's visually-hidden label rather than by the visible column header, which
   * appears once and names the column for sighted users only.
   */
  function lastCells(card: ReturnType<typeof within>): HTMLElement[] {
    return card
      .getAllByText('Last time', { exact: false })
      .map((label: HTMLElement) => label.parentElement as HTMLElement)
  }

  it('shows what she lifted last time, per set, without a tap', async () => {
    // The feature that beats the paper notebook. It has to be readable mid-set at arm's length,
    // which is why it is a column of values and not a tooltip, an icon, or a subtitle.
    mockApi({ last: { 'ex-1': squatLast } })
    renderScreen()

    const squat = await block('Back Squat')
    // DESIGN.md's format, exactly: `72.5 × 8`. Only one row exists before anything is saved, so
    // only last time's set 1 is on screen — the strip grows with the rows.
    await waitFor(() => expect(lastCells(squat)[0]).toHaveTextContent(/^Last time\s*72\.5\s*×\s*8$/))
    expect(lastCells(squat)).toHaveLength(1)

    // The column is named once, above it — not prefixed onto every row.
    expect(squat.getAllByText('Last', { exact: true })).toHaveLength(1)
  })

  it('carries the strip down as sets are logged', async () => {
    mockApi({ last: { 'ex-1': squatLast } })
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    const squat = await block('Back Squat')
    await waitFor(() => expect(squat.getByText(/72\.5/)).toBeInTheDocument())

    await logSet('Back Squat', '100', '8')

    // Row 1 keeps last week's set 1; the new pending row 2 shows last week's set 2. The values
    // stack by set number rather than repeating one summary for the exercise.
    await waitFor(() => expect(squat.getByLabelText(/set 2 weight/)).toBeInTheDocument())
    expect(lastCells(squat)).toHaveLength(2)
    expect(lastCells(squat)[0]).toHaveTextContent(/^Last time\s*72\.5\s*×\s*8$/)
    expect(lastCells(squat)[1]).toHaveTextContent(/^Last time\s*75\s*×\s*6$/)

    // Two rows of values, still one header. This is the assertion the change was made for.
    expect(squat.getAllByText('Last', { exact: true })).toHaveLength(1)
  })

  it('shows a single dash when there is nothing to show', async () => {
    // api.md #33 collapses "never done it" and "not yours" into the same mostRecent: null, so
    // there is one empty state and it is a dash — not "no data yet" copy, which would break the
    // column's shape and stop the strip being scannable.
    mockApi({ last: { 'ex-1': { mostRecent: undefined } } })
    renderScreen()

    const squat = await block('Back Squat')
    expect(await squat.findByText('–')).toBeInTheDocument()
    expect(squat.queryByText(/no data/i)).not.toBeInTheDocument()
  })

  it('does not make the screen wait for last-time', async () => {
    // Eight exercises is eight requests and there is no batch endpoint. The reason that is
    // acceptable is that nothing blocks on them: the day, its targets, and the inputs come from
    // the program alone, so she can log her first set before any of them land.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const fetchMock = mockApi({ holdLast: held, last: { 'ex-1': squatLast } })
    renderScreen()

    const squat = await block('Back Squat')
    expect(squat.getByLabelText(/set 1 reps/)).toBeInTheDocument()
    expect(squat.getByRole('button', { name: 'Save set' })).toBeEnabled()
    // Still the empty state, and still fully usable.
    expect(squat.getByText('–')).toBeInTheDocument()

    await userEvent.type(squat.getByLabelText(/set 1 reps/), '8')
    await userEvent.click(squat.getByRole('button', { name: 'Save set' }))
    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(1))

    release()
    await waitFor(() => expect(squat.getByText(/72\.5/)).toBeInTheDocument())
  })

  it('asks once per exercise, not once per prescription', async () => {
    // A day can prescribe the same exercise twice (top sets then back-offs). One request.
    const repeated: MeProgramWrapper = {
      program: {
        ...program.program,
        days: [
          {
            id: 'day-1', title: 'Lower', position: 1,
            prescriptions: [
              { id: 'presc-1', position: 1, targetSets: 1, targetReps: '5', exercise: { id: 'ex-1', name: 'Back Squat' } },
              { id: 'presc-1b', position: 2, targetSets: 3, targetReps: '8', exercise: { id: 'ex-1', name: 'Back Squat' } },
            ],
          },
        ],
      },
    }

    const fetchMock = mockApi({ program: repeated, last: { 'ex-1': squatLast } })
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await waitFor(() => expect(lastRequests(fetchMock)).toHaveLength(1))
    expect(lastRequests(fetchMock)[0]).toContain('exercise_id=ex-1')
  })

  it('does not pass today’s own sets off as last time', async () => {
    // Since #45 the row is created by the first logged set, and #98 resumes it rather than
    // making a second — so on a resumed session /api/me/last answers with *this* session for
    // anything already logged today. Those sets are already on screen in the rows above;
    // repeating them under a `Last` label would be a second, wronger copy of what she is
    // looking at.
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        performedOn: todayForClient(), programDayId: 'day-1', comment: '', sessionId: SESSION_ID,
      }),
    )

    const history: HistoryResponse = {
      items: [
        {
          id: 'set-1', setNumber: 1, weightKg: 100, reps: 8, loggedAt: '2026-07-26T12:00:00Z',
          session: { id: SESSION_ID, performedOn: '2026-07-26', comment: null },
          exercise: { id: 'ex-1', name: 'Back Squat' },
        },
      ],
      nextCursor: null,
    }

    mockApi({
      history,
      last: {
        'ex-1': {
          mostRecent: {
            sessionId: SESSION_ID,
            performedOn: '2026-07-26',
            exercise: { id: 'ex-1', name: 'Back Squat' },
            sets: [{ id: 'set-1', setNumber: 1, weightKg: 100, reps: 8, loggedAt: '2026-07-26T12:00:00Z' }],
          },
        },
      },
    })
    renderScreen()

    const squat = await block('Back Squat')
    await waitFor(() => expect(squat.getByLabelText(/set 2 weight/)).toBeInTheDocument())

    // The saved row shows 100 once, in the weight column. The Last column stays on dashes.
    expect(squat.getAllByText('–')).toHaveLength(2)
    expect(squat.getAllByText('100')).toHaveLength(1)
  })

  it('falls back to the dash when the last-time read fails', async () => {
    // Decision support, not a write. Losing it costs her the assist and nothing else, so it
    // degrades to the pre-#46 state rather than putting an error on a logging screen.
    const fetchMock = mockApi({ onLast: () => 'network' })
    renderScreen()

    const squat = await block('Back Squat')
    expect(await squat.findByText('–')).toBeInTheDocument()
    expect(squat.queryByRole('alert')).not.toBeInTheDocument()
    // One silent retry per exercise before giving up: two exercises, two attempts each.
    await waitFor(() => expect(lastRequests(fetchMock)).toHaveLength(4))
  })

  it('shows reps alone for a bodyweight set', async () => {
    mockApi({
      last: {
        'ex-1': {
          mostRecent: {
            sessionId: 'session-last-week', performedOn: '2026-07-19',
            exercise: { id: 'ex-1', name: 'Back Squat' },
            sets: [{ id: 'a', setNumber: 1, weightKg: null, reps: 12, loggedAt: '2026-07-19T12:00:00Z' }],
          },
        },
      },
    })
    renderScreen()

    const squat = await block('Back Squat')
    // weight_kg NULL is bodyweight (database.md). Reps alone, with no × at all: "– × 12" would
    // read as a missing number rather than an absent one.
    await waitFor(() => expect(lastCells(squat)[0]).toHaveTextContent(/^Last time\s*12$/))
  })

  // -- Session creation moves to the first set --

  it('creates the session with the first logged set, not before', async () => {
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    // Arriving on the screen writes nothing: a workout that never happened leaves no row.
    expect(sessionPosts(fetchMock)).toHaveLength(0)

    await logSet('Back Squat', '100', '8')

    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(1))
    expect(sessionPosts(fetchMock)).toHaveLength(1)
    expect(sessionPosts(fetchMock)[0].body).toMatchObject({ programDayId: 'day-1', comment: null })
    expect(setPosts(fetchMock)[0].body).toMatchObject({
      exerciseId: 'ex-1',
      programDayExerciseId: 'presc-1',
      setNumber: 1,
      weightKg: 100,
      reps: 8,
    })
  })

  it('creates one session when two exercises log their first set at once', async () => {
    // The race the shared in-flight promise exists for. Both saves call ensureSession before
    // either resolves; a per-caller check would see "no session yet" twice and POST twice, and
    // workout_sessions has no unique constraint that would catch it.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const fetchMock = mockApi({ holdCreate: held })
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await logSet('Back Squat', '100', '8')
    await logSet('Leg Curl', '40', '12')
    release()

    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(2))
    expect(sessionPosts(fetchMock)).toHaveLength(1)
    // Both sets landed in the same row.
    expect(new Set(setPosts(fetchMock).map((call) => call.url)).size).toBe(1)
  })

  it('pre-fills the next set from the one just saved', async () => {
    // ui-ux.md: "Add set pre-fills from the previous set (most sets repeat weight); editing is
    // the exception path."
    mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await logSet('Back Squat', '100', '8')

    const squat = await block('Back Squat')
    await waitFor(() => expect(squat.getByLabelText(/set 2 weight/)).toHaveValue('100'))
    expect(squat.getByLabelText(/set 2 reps/)).toHaveValue('8')
  })

  it('keeps saved sets and numbers the next one after them', async () => {
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await logSet('Back Squat', '100', '8')
    const squat = await block('Back Squat')
    await waitFor(() => expect(squat.getByLabelText(/set 2 weight/)).toBeInTheDocument())
    await userEvent.click(squat.getByRole('button', { name: 'Save set' }))

    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(2))
    expect(setPosts(fetchMock)[1].body).toMatchObject({ setNumber: 2, weightKg: 100, reps: 8 })
    // Only one session for both.
    expect(sessionPosts(fetchMock)).toHaveLength(1)
  })

  // -- Removing a set (#105) --

  const deletes = (f: ReturnType<typeof mockApi>) => callsTo(f, 'DELETE', /\/api\/me\/sets\//)

  /** Logs `count` sets of Back Squat and returns the block. */
  async function logRun(count: number) {
    await logSet('Back Squat', '100', '8')
    const squat = await block('Back Squat')
    for (let next = 2; next <= count; next += 1) {
      await waitFor(() => expect(squat.getByLabelText(new RegExp(`set ${next} weight`))).toBeInTheDocument())
      await userEvent.click(squat.getByRole('button', { name: 'Save set' }))
    }
    await waitFor(() =>
      expect(squat.getByLabelText(new RegExp(`set ${count + 1} weight`))).toBeInTheDocument(),
    )
    return squat
  }

  it('needs two deliberate taps to remove a set, and no dialog', async () => {
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })
    const squat = await logRun(1)

    // Nothing destructive is on screen until the row is opened: the first tap cannot delete.
    expect(squat.queryByRole('button', { name: /Remove set/ })).not.toBeInTheDocument()

    await userEvent.click(squat.getByRole('button', { name: /^Set 1,/ }))
    expect(squat.getByRole('button', { name: 'Remove set 1' })).toBeInTheDocument()
    // No dialog stands between her and the fix.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(squat.getByRole('button', { name: 'Remove set 1' }))

    await waitFor(() => expect(deletes(fetchMock)).toHaveLength(1))
    expect(deletes(fetchMock)[0].url).toBe('/api/me/sets/set-1')
  })

  it('closes the row again on a second tap in the same place', async () => {
    // The safety property. The destructive control sits below the row, so tapping twice where
    // she just tapped collapses it rather than removing the set — her finger has to move.
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })
    const squat = await logRun(1)

    const row = squat.getByRole('button', { name: /^Set 1,/ })
    await userEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(squat.queryByRole('button', { name: /Remove set/ })).not.toBeInTheDocument()
    expect(deletes(fetchMock)).toHaveLength(0)
  })

  it('closes the numbering gap after removing a middle set', async () => {
    // Mirrors the server's renumbering. Left alone, the block would read "1, 3" after fixing a
    // double-tap, and the next set would be numbered 3 again — a collision.
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })
    const squat = await logRun(3)

    await userEvent.click(squat.getByRole('button', { name: /^Set 2,/ }))
    await userEvent.click(squat.getByRole('button', { name: 'Remove set 2' }))

    await waitFor(() => expect(deletes(fetchMock)).toHaveLength(1))
    // Two rows left, numbered 1 and 2 — and the pending row follows them at 3.
    await waitFor(() => expect(squat.getByLabelText(/set 3 weight/)).toBeInTheDocument())
    expect(squat.getByRole('button', { name: /^Set 1,/ })).toBeInTheDocument()
    expect(squat.getByRole('button', { name: /^Set 2,/ })).toBeInTheDocument()
    expect(squat.queryByRole('button', { name: /^Set 3,/ })).not.toBeInTheDocument()

    // The next set goes in at 3, not back at 3-that-already-exists.
    await userEvent.click(squat.getByRole('button', { name: 'Save set' }))
    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(4))
    expect(setPosts(fetchMock)[3].body).toMatchObject({ setNumber: 3 })
  })

  it('keeps the set and says so when removing it fails', async () => {
    // Same split as every other write on this screen: unreachable is worth another tap, a
    // refusal is not. A set that is still there must not look deleted.
    const fetchMock = mockApi({ onDeleteSet: () => 'network' })
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })
    const squat = await logRun(2)

    await userEvent.click(squat.getByRole('button', { name: /^Set 1,/ }))
    await userEvent.click(squat.getByRole('button', { name: 'Remove set 1' }))

    expect(await squat.findByRole('alert')).toHaveTextContent('No connection.')
    expect(squat.getByRole('button', { name: /^Set 1,/ })).toBeInTheDocument()
    expect(squat.getByRole('button', { name: /^Set 2,/ })).toBeInTheDocument()
    // Still open, so the retry is one tap away.
    expect(squat.getByRole('button', { name: 'Remove set 1' })).toBeEnabled()
    expect(deletes(fetchMock)).toHaveLength(1)
  })

  it('reports what the server said when it refuses to remove a set', async () => {
    // Past the same-day window the API answers 404, the same shape as a set that never existed.
    mockApi({ onDeleteSet: () => rejected(404, 'not_found', 'Not Found') })
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })
    const squat = await logRun(1)

    await userEvent.click(squat.getByRole('button', { name: /^Set 1,/ }))
    await userEvent.click(squat.getByRole('button', { name: 'Remove set 1' }))

    expect(await squat.findByRole('alert')).toHaveTextContent('Not Found')
    expect(squat.queryByText(/No connection/)).not.toBeInTheDocument()
    expect(squat.getByRole('button', { name: /^Set 1,/ })).toBeInTheDocument()
  })

  it('announces the row with its numbers rather than its cells', async () => {
    mockApi({ last: { 'ex-1': squatLast } })
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })
    const squat = await logRun(1)

    // The visible cells read "1 Last time 72.5 × 8 100 8", which is not a sentence. The label
    // carries the same facts in an order that is, including last time — the button's contents
    // stop being announced separately once it has one.
    expect(
      squat.getByRole('button', { name: 'Set 1, 100 kilograms by 8 reps. Last time 72.5 kilograms by 8 reps' }),
    ).toBeInTheDocument()
  })

  // -- Failure handling on a set write --

  it('keeps the typed set and offers a retry when the network drops', async () => {
    // The gym-floor failure. Silent loss is the worst outcome: she believes it saved, it did
    // not, and she finds out never. The values stay put and the button changes what it promises.
    const fetchMock = mockApi({ onLogSet: (attempt) => (attempt === 1 ? 'network' : ok({ id: 'set-1', setNumber: 1, weightKg: 100, reps: 8 }, 201)) })
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await logSet('Back Squat', '100', '8')

    const squat = await block('Back Squat')
    expect(await squat.findByRole('alert')).toHaveTextContent('No connection. Nothing was saved — try again.')
    expect(squat.getByLabelText(/set 1 weight/)).toHaveValue('100')
    expect(squat.getByLabelText(/set 1 reps/)).toHaveValue('8')

    // Retrying the same tap works, because nothing reached the server the first time.
    await userEvent.click(squat.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(2))
    await waitFor(() => expect(squat.getByLabelText(/set 2 weight/)).toBeInTheDocument())
  })

  it('shows what the server said when it refuses a set', async () => {
    // #42's lesson: "unreachable" and "rejected" are different facts and need different words.
    // A refusal will not fix itself on a retry, so the message has to say what was wrong.
    mockApi({ onLogSet: () => rejected(400, 'unknown_exercise', 'Unknown exercise_id.') })
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await logSet('Back Squat', '100', '8')

    const squat = await block('Back Squat')
    expect(await squat.findByRole('alert')).toHaveTextContent('Unknown exercise_id.')
    expect(squat.queryByText(/No connection/)).not.toBeInTheDocument()
  })

  it('asks for reps before spending a request on it', async () => {
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    const squat = await block('Back Squat')
    await userEvent.type(squat.getByLabelText(/set 1 weight/), '100')
    await userEvent.click(squat.getByRole('button', { name: 'Save set' }))

    expect(await squat.findByRole('alert')).toHaveTextContent('Enter how many reps you did.')
    expect(setPosts(fetchMock)).toHaveLength(0)
    expect(sessionPosts(fetchMock)).toHaveLength(0)
  })

  it('logs a bodyweight set with no weight', async () => {
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    const squat = await block('Back Squat')
    await userEvent.type(squat.getByLabelText(/set 1 reps/), '12')
    await userEvent.click(squat.getByRole('button', { name: 'Save set' }))

    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(1))
    // database.md: weight_kg is NULL for bodyweight, not 0.
    expect(setPosts(fetchMock)[0].body).toMatchObject({ weightKg: null, reps: 12 })
  })

  // -- Resume --

  it('resumes the existing session and its sets instead of starting a second one', async () => {
    // Her phone locks between sets. The row already exists, so the screen must find it, read
    // back what is in it, and carry on numbering — logged_sets has no unique constraint on
    // (session_id, exercise_id, set_number), so restarting at 1 would write duplicates.
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        performedOn: todayForClient(),
        programDayId: 'day-1',
        comment: 'Knee felt off.',
        sessionId: SESSION_ID,
      }),
    )

    const history: HistoryResponse = {
      items: [
        {
          id: 'set-2', setNumber: 2, weightKg: 102.5, reps: 8, loggedAt: '2026-07-26T12:05:00Z',
          session: { id: SESSION_ID, performedOn: '2026-07-26', comment: null },
          exercise: { id: 'ex-1', name: 'Back Squat' },
        },
        {
          id: 'set-1', setNumber: 1, weightKg: 100, reps: 8, loggedAt: '2026-07-26T12:00:00Z',
          session: { id: SESSION_ID, performedOn: '2026-07-26', comment: null },
          exercise: { id: 'ex-1', name: 'Back Squat' },
        },
        {
          // A set from an earlier workout. Same exercise, different session — must not appear.
          id: 'old', setNumber: 1, weightKg: 90, reps: 5, loggedAt: '2026-07-19T12:00:00Z',
          session: { id: 'session-old', performedOn: '2026-07-19', comment: null },
          exercise: { id: 'ex-1', name: 'Back Squat' },
        },
      ],
      nextCursor: null,
    }

    const fetchMock = mockApi({ history })
    renderScreen()

    const squat = await block('Back Squat')
    await waitFor(() => expect(squat.getByLabelText(/set 3 weight/)).toBeInTheDocument())

    // Both saved sets are on screen, in set order, and the stale one is not.
    expect(squat.getByText('102.5')).toBeInTheDocument()
    expect(squat.getByText('100')).toBeInTheDocument()
    expect(squat.queryByText('90')).not.toBeInTheDocument()

    // Pre-filled from the last saved set, and the note came back.
    expect(squat.getByLabelText(/set 3 weight/)).toHaveValue('102.5')
    expect(screen.getByLabelText('Note for your trainer')).toHaveValue('Knee felt off.')
    expect(screen.getByText('Picking up where you left off.')).toBeInTheDocument()

    // The whole point: no second row.
    await logSet('Back Squat', '', '6')
    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(1))
    expect(sessionPosts(fetchMock)).toHaveLength(0)
    expect(setPosts(fetchMock)[0].url).toBe(`/api/me/sessions/${SESSION_ID}/sets`)
    expect(setPosts(fetchMock)[0].body).toMatchObject({ setNumber: 3 })
  })

  /** History as it looks after two sets were logged into today's session for day-1. */
  function todaysSessionHistory(comment: string | null = null): HistoryResponse {
    const session = {
      id: SESSION_ID,
      performedOn: todayForClient(),
      comment,
      programDayId: 'day-1',
    }
    return {
      items: [
        {
          id: 'set-2', setNumber: 2, weightKg: 102.5, reps: 8, loggedAt: '2026-07-28T12:05:00Z',
          session, exercise: { id: 'ex-1', name: 'Back Squat' },
        },
        {
          id: 'set-1', setNumber: 1, weightKg: 100, reps: 8, loggedAt: '2026-07-28T12:00:00Z',
          session, exercise: { id: 'ex-1', name: 'Back Squat' },
        },
      ],
      nextCursor: null,
    }
  }

  it('restores today’s session on mount, with no draft and without writing', async () => {
    // #102: program_day_id in history's session summary makes today's session identifiable
    // from a read. Before it, POST was the only route that resolved the triple, so the screen
    // could not know the row existed until it had already written to it.
    const fetchMock = mockApi({ history: todaysSessionHistory() })
    renderScreen()

    const squat = await block('Back Squat')
    await waitFor(() => expect(squat.getByLabelText(/set 3 weight/)).toBeInTheDocument())
    expect(squat.getByText('102.5')).toBeInTheDocument()
    expect(screen.getByText('Picking up where you left off.')).toBeInTheDocument()

    // Nothing was created to find that out.
    expect(sessionPosts(fetchMock)).toHaveLength(0)
  })

  it('does not show today’s own sets as last time before the first save', async () => {
    // The seam #102 closes. #46 filters last-time results belonging to the current session, but
    // that filter needs a session id — and until the mount-time restore the screen had none
    // before the first save. So a client reopening mid-workout saw her own earlier sets from
    // today sitting under the Last header.
    mockApi({
      history: todaysSessionHistory(),
      last: {
        'ex-1': {
          mostRecent: {
            sessionId: SESSION_ID,
            performedOn: todayForClient(),
            exercise: { id: 'ex-1', name: 'Back Squat' },
            sets: [{ id: 'set-1', setNumber: 1, weightKg: 100, reps: 8, loggedAt: '2026-07-28T12:00:00Z' }],
          },
        },
      },
    })
    renderScreen()

    const squat = await block('Back Squat')
    await waitFor(() => expect(squat.getByLabelText(/set 3 weight/)).toBeInTheDocument())

    // Three rows, every Last cell still a dash — her own sets are shown as her own sets, in
    // the weight column, and not a second time as history.
    await waitFor(() => expect(lastCells(squat)).toHaveLength(3))
    for (const cell of lastCells(squat)) {
      expect(cell).toHaveTextContent(/^Last time\s*–$/)
    }
  })

  it('does not resume another program day logged the same afternoon', async () => {
    // The case program_day_id exists to answer, and the reason matching on date alone is not
    // enough: #98 treats Day A in the morning and Day B in the evening as two sessions, so a
    // date is not an identity. Opening Lower must not adopt Upper's row.
    const fetchMock = mockApi({
      history: {
        items: [
          {
            id: 'other', setNumber: 1, weightKg: 40, reps: 12, loggedAt: '2026-07-28T09:00:00Z',
            session: {
              id: 'session-upper',
              performedOn: todayForClient(),
              comment: 'Upper done early.',
              programDayId: 'day-2',
            },
            exercise: { id: 'ex-2', name: 'Leg Curl' },
          },
        ],
        nextCursor: null,
      },
    })
    renderScreen('day-1')

    const squat = await block('Back Squat')
    // A fresh block: set 1, nothing restored, nothing resumed.
    expect(squat.getByLabelText(/set 1 weight/)).toBeInTheDocument()
    expect(screen.queryByText('Picking up where you left off.')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Note for your trainer')).toHaveValue('')

    // And the first set creates Lower's own session rather than writing into Upper's.
    await logSet('Back Squat', '100', '8')
    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(1))
    expect(sessionPosts(fetchMock)).toHaveLength(1)
    expect(setPosts(fetchMock)[0].body).toMatchObject({ setNumber: 1 })
  })

  it('brings back the note already on the resumed session', async () => {
    // Otherwise she reopens to an empty box and anything she types replaces a note she was
    // never shown.
    mockApi({ history: todaysSessionHistory('Knee ached on set 2.') })
    renderScreen()

    expect(await screen.findByLabelText('Note for your trainer')).toHaveValue('Knee ached on set 2.')
  })

  it('falls back to resuming at first save when history cannot be read', async () => {
    // The mount-time restore is an optimisation on top of #45's path, not a replacement. With
    // no draft there is nothing proving a session exists, so a failed history read must not
    // take the screen down — ensureSession still catches it at the first save.
    let allowHistory = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))

      if (url === '/api/me/program') {
        return { ok: true, status: 200, json: async () => program }
      }
      if (url.startsWith('/api/me/last')) {
        return { ok: true, status: 200, json: async () => ({ mostRecent: null }) }
      }
      if (url.startsWith('/api/me/history')) {
        if (!allowHistory) {
          throw new TypeError('Failed to fetch')
        }
        return { ok: true, status: 200, json: async () => todaysSessionHistory() }
      }
      if (url === '/api/me/sessions' && method === 'POST') {
        allowHistory = true
        return { ok: true, status: 200, json: async () => ({ id: SESSION_ID }) }
      }
      if (url.endsWith('/sets') && method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 'new', setNumber: body.setNumber, weightKg: body.weightKg, reps: body.reps }),
        }
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderScreen()
    // The screen renders rather than refusing: nothing proved a session existed.
    const squat = await block('Back Squat')
    expect(squat.getByLabelText(/set 1 weight/)).toBeInTheDocument()

    await logSet('Back Squat', '105', '6')

    // #45's read-back still numbers it correctly.
    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(1))
    expect(setPosts(fetchMock)[0].body).toMatchObject({ setNumber: 3 })
  })

  it('continues set numbering after finishing and reopening the same day', async () => {
    // Reported: 31 sets in one session with set_number cycling 1-4 seven times. Finish clears
    // the draft, so a restart has no session id to resume from, the read-back never runs, and
    // #98 hands the same row back to a screen that thinks it is empty.
    //
    // No draft here on purpose — that is the whole point of the bug.
    const fetchMock = mockApi({
      // #98: an existing row for this (client, date, program day) comes back as 200.
      onCreateSession: () => ok({ id: SESSION_ID }, 200),
      history: {
        items: [
          {
            id: 'set-2', setNumber: 2, weightKg: 100, reps: 8, loggedAt: '2026-07-26T12:05:00Z',
            session: { id: SESSION_ID, performedOn: '2026-07-26', comment: null },
            exercise: { id: 'ex-1', name: 'Back Squat' },
          },
          {
            id: 'set-1', setNumber: 1, weightKg: 100, reps: 8, loggedAt: '2026-07-26T12:00:00Z',
            session: { id: SESSION_ID, performedOn: '2026-07-26', comment: null },
            exercise: { id: 'ex-1', name: 'Back Squat' },
          },
        ],
        nextCursor: null,
      },
    })

    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()

    await logSet('Back Squat', '100', '8')

    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(1))
    // Set 3, not set 1. Two sets are already in this row.
    expect(setPosts(fetchMock)[0].body).toMatchObject({ setNumber: 3 })
    expect(setPosts(fetchMock)[0].url).toBe(`/api/me/sessions/${SESSION_ID}/sets`)

    // And the earlier sets come back on screen rather than the block looking empty.
    const squat = await block('Back Squat')
    await waitFor(() => expect(squat.getByLabelText(/set 4 weight/)).toBeInTheDocument())
  })

  it('still lands the note when finishing a reopened day with nothing new logged', async () => {
    // The same seam as the numbering bug. With no sets this visit the screen has no session id,
    // so Finish takes the create-with-comment path — but #98 resumes the existing row and
    // deliberately does not overwrite its comment, so the note would vanish without a word.
    const fetchMock = mockApi({ onCreateSession: () => ok({ id: SESSION_ID }, 200) })
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await userEvent.type(screen.getByLabelText('Note for your trainer'), 'Forgot to say: knee ached.')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(patches(fetchMock)).toHaveLength(1)
    expect(patches(fetchMock)[0].body).toEqual({ comment: 'Forgot to say: knee ached.' })
  })

  it('refuses to render rather than log blind when the resume read fails', async () => {
    // Continuing here would mean writing sets into a session whose contents are unknown, which
    // is exactly how duplicate set numbers happen.
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        performedOn: todayForClient(), programDayId: 'day-1', comment: '', sessionId: SESSION_ID,
      }),
    )

    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/me/program') {
        return { ok: true, status: 200, json: async () => program }
      }
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)
    renderScreen()

    expect(
      await screen.findByRole('heading', { name: 'We couldn’t load your workout' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save set' })).not.toBeInTheDocument()
  })

  it('does not restore a draft from a different workout', async () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        performedOn: '2020-01-01', programDayId: 'day-1', comment: 'Old note.', sessionId: 'stale-session',
      }),
    )
    mockApi()
    renderScreen()

    expect(await screen.findByLabelText('Note for your trainer')).toHaveValue('')
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
    // History is read on every mount since #102, but it holds nothing for this day, so no
    // session is resumed from either source.
    expect(screen.queryByText('Picking up where you left off.')).not.toBeInTheDocument()
  })

  // -- Finishing --

  it('patches the comment onto the session it logged into', async () => {
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await logSet('Back Squat', '100', '8')
    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(1))

    await userEvent.type(screen.getByLabelText('Note for your trainer'), 'Shoulder tweaked on OHP.')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(patches(fetchMock)).toHaveLength(1)
    expect(patches(fetchMock)[0].url).toBe(`/api/me/sessions/${SESSION_ID}`)
    expect(patches(fetchMock)[0].body).toEqual({ comment: 'Shoulder tweaked on OHP.' })
    // One PATCH, not one per keystroke.
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('writes the note in the create when nothing was logged', async () => {
    // No sets means no row yet, and POST takes a comment directly — one request rather than a
    // create followed by a patch.
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await userEvent.type(screen.getByLabelText('Note for your trainer'), 'Rest day, just stretching.')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(sessionPosts(fetchMock)).toHaveLength(1)
    expect(sessionPosts(fetchMock)[0].body).toMatchObject({ comment: 'Rest day, just stretching.' })
    expect(patches(fetchMock)).toHaveLength(0)
  })

  it('writes nothing at all when there was no workout and no note', async () => {
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(sessionPosts(fetchMock)).toHaveLength(0)
    expect(patches(fetchMock)).toHaveLength(0)
  })

  it('asks before finishing on top of a set that was typed but never saved', async () => {
    // The last place a set could still vanish silently. It names the exercise and waits.
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    const squat = await block('Back Squat')
    await userEvent.type(squat.getByLabelText(/set 1 weight/), '100')
    await userEvent.type(squat.getByLabelText(/set 1 reps/), '8')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unsaved set on Back Squat. Discard and finish?',
    )
    // Asking is not doing: nothing is written and nothing has left the screen until she answers.
    expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument()
    expect(sessionPosts(fetchMock)).toHaveLength(0)
    expect(squat.getByLabelText(/set 1 weight/)).toHaveValue('100')
  })

  it('finishes when she confirms the discard, without saving the row', async () => {
    // The point of #108: one tap answers, where #45 wanted the digits cleared by hand.
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    const squat = await block('Back Squat')
    await userEvent.type(squat.getByLabelText(/set 1 weight/), '100')
    await userEvent.type(squat.getByLabelText(/set 1 reps/), '8')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }))

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
    // Discarded means discarded. The row she abandoned must not be written on the way out.
    expect(setPosts(fetchMock)).toHaveLength(0)
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('stays on the workout with the typed set intact when she cancels', async () => {
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    const squat = await block('Back Squat')
    await userEvent.type(squat.getByLabelText(/set 1 weight/), '100')
    await userEvent.type(squat.getByLabelText(/set 1 reps/), '8')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument()
    expect(sessionPosts(fetchMock)).toHaveLength(0)
    expect(squat.getByLabelText(/set 1 weight/)).toHaveValue('100')
    expect(squat.getByLabelText(/set 1 reps/)).toHaveValue('8')

    // Cancel returns the bar to the control she started from, not a dead end.
    expect(screen.getByRole('button', { name: 'Finish workout' })).toBeEnabled()

    // And the row is still savable, which is the other half of what Cancel is for.
    await userEvent.click(squat.getByRole('button', { name: 'Save set' }))
    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(1))
  })

  it('puts focus on Cancel when the prompt replaces the Finish button', async () => {
    // The button that raised the prompt unmounts with it. Without the move, focus falls to the
    // body and a keyboard user walks the whole screen back to an answer they just asked for.
    mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    const squat = await block('Back Squat')
    await userEvent.type(squat.getByLabelText(/set 1 reps/), '8')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
  })

  it('names every exercise holding an unsaved set', async () => {
    mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    const squat = await block('Back Squat')
    await userEvent.type(squat.getByLabelText(/set 1 reps/), '8')
    const curl = await block('Leg Curl')
    await userEvent.type(curl.getByLabelText(/set 1 reps/), '12')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unsaved sets on Back Squat and Leg Curl. Discard and finish?',
    )
  })

  it('finishes after several sets without touching the pre-filled row that follows', async () => {
    // Reported: four sets logged, Finish tapped, guard still blocks. Reproduces the real
    // sequence rather than the one-set case — set 1 is typed, sets 2-4 are saved straight from
    // the pre-fill, and the fifth row is left exactly as the app suggested it.
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await logSet('Back Squat', '100', '8')
    const squat = await block('Back Squat')

    for (const next of [2, 3, 4]) {
      await waitFor(() => expect(squat.getByLabelText(new RegExp(`set ${next} weight`))).toBeInTheDocument())
      await userEvent.click(squat.getByRole('button', { name: 'Save set' }))
    }

    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(4))
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
  })

  it('takes the discard prompt down once that set is saved', async () => {
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    const squat = await block('Back Squat')
    await userEvent.type(squat.getByLabelText(/set 1 weight/), '100')
    await userEvent.type(squat.getByLabelText(/set 1 reps/), '8')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unsaved set on Back Squat')

    await userEvent.click(squat.getByRole('button', { name: 'Save set' }))
    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(1))

    // The condition is gone, so the question about it must be too — it now names a set that is
    // safely on the server, and offers to discard it.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Finish workout' })).toBeInTheDocument()
  })

  it('finishes over a pre-filled row nobody typed into', async () => {
    // The counterpart to the guard above, and the reason `dirty` exists. Every saved set leaves
    // a pre-filled row behind (ui-ux.md), so treating "this row has numbers in it" as unsaved
    // work would block Finish forever after the first set.
    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await logSet('Back Squat', '100', '8')
    const squat = await block('Back Squat')
    await waitFor(() => expect(squat.getByLabelText(/set 2 weight/)).toHaveValue('100'))

    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(setPosts(fetchMock)).toHaveLength(1)
  })

  it('keeps the note when the comment patch fails', async () => {
    const fetchMock = mockApi({ onPatch: () => 'network' })
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await logSet('Back Squat', '100', '8')
    await waitFor(() => expect(setPosts(fetchMock)).toHaveLength(1))

    await userEvent.type(screen.getByLabelText('Note for your trainer'), 'Deload next week?')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No connection.')
    expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument()
    expect(localStorage.getItem(DRAFT_KEY)).toContain('Deload next week?')
    // The session id survives, so a retry patches the same row rather than making another.
    expect(localStorage.getItem(DRAFT_KEY)).toContain(SESSION_ID)
    expect(screen.getByRole('button', { name: 'Finish workout' })).toBeEnabled()
  })

  it('creates one session when Finish is tapped again before the first request answers', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const fetchMock = mockApi({ holdCreate: held })
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    await userEvent.type(screen.getByLabelText('Note for your trainer'), 'Just a note.')
    await userEvent.click(screen.getByRole('button', { name: 'Finish workout' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Saving' }))
    release()

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(sessionPosts(fetchMock)).toHaveLength(1)
  })

  // -- Carried over from #47 --

  it('stamps performed_on from the client timezone rather than the browser clock', async () => {
    // 02:30 UTC on the 26th is 22:30 on the 25th in Toronto. PATCH /api/me/sets measures its
    // same-day window against users.timezone (api.md #32), so a browser-stamped date would
    // disagree with the window governing its own sets.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-07-26T02:30:00Z'))
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    const fetchMock = mockApi()
    renderScreen()
    await screen.findByRole('heading', { name: 'Lower', level: 1 })

    const squat = await block('Back Squat')
    await user.type(squat.getByLabelText(/set 1 reps/), '5')
    await user.click(squat.getByRole('button', { name: 'Save set' }))

    await waitFor(() => expect(sessionPosts(fetchMock)).toHaveLength(1))
    expect(sessionPosts(fetchMock)[0].body.performedOn).toBe('2026-07-25')
  })

  it('offers a way back when the day is not in the active program', async () => {
    const fetchMock = mockApi()
    renderScreen('day-gone')

    expect(
      await screen.findByRole('heading', { name: 'That workout isn’t in your program' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to today' })).toHaveAttribute('href', '/')
    expect(sessionPosts(fetchMock)).toHaveLength(0)
  })

  it('offers a retry when the program cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderScreen()

    expect(
      await screen.findByRole('heading', { name: 'We couldn’t load your workout' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

/** The draft key the screen will look for, in the client's timezone rather than the runner's. */
function todayForClient(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date())
}
