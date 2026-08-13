import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ClientResponse,
  ClientSessionResponse,
  ProgramResponse,
  ScheduleResponse,
} from '../api/types.gen'
import { ClientDetailScreen } from './ClientDetailScreen'

const ada: ClientResponse = {
  id: 'client-ada',
  email: 'ada@example.com',
  displayName: 'Ada',
  timezone: 'America/Toronto',
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
}

const grace: ClientResponse = { ...ada, id: 'client-grace', displayName: 'Grace', email: 'grace@example.com' }

const adasProgram: ProgramResponse = {
  id: 'program-1',
  clientId: 'client-ada',
  title: 'Winter Block',
  status: 'active',
  startsOn: '2026-01-06',
  notes: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const gracesProgram: ProgramResponse = { ...adasProgram, id: 'program-2', clientId: 'client-grace', title: 'Grace Block' }

const schedule: ScheduleResponse = {
  id: 'schedule-1',
  clientId: 'client-ada',
  kind: 'workout_reminder',
  // The wire format #29 produces, which the form has to unpack before an input can show it.
  sendTime: '07:30:00',
  daysOfWeek: [1, 3, 5],
  enabled: true,
}

function session(performedOn: string, comment: string | null = null): ClientSessionResponse {
  return { id: `session-${performedOn}`, performedOn, programDayId: 'day-1', comment, createdAt: `${performedOn}T18:00:00Z` }
}

describe('ClientDetailScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Routes by method and path the way the real API does, including 404 for "no schedule". */
  function mockApi(options: {
    clients?: ClientResponse[]
    programs?: ProgramResponse[]
    sessions?: ClientSessionResponse[]
    schedule?: ScheduleResponse | null
    onPost?: (body: unknown) => Partial<Response>
    onPatch?: (id: string, body: unknown) => Partial<Response>
  }) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const ok = (json: unknown, status = 200) => Promise.resolve({ ok: true, status, json: async () => json })

      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({}),
          ...options.onPost?.(JSON.parse(String(init.body))),
        })
      }

      if (init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
          ...options.onPatch?.(url.replace('/api/schedules/', ''), JSON.parse(String(init.body))),
        })
      }

      if (url.endsWith('/schedule')) {
        // #29 answers 404 for "no schedule yet" rather than a null wrapper.
        return options.schedule == null
          ? Promise.resolve({
              ok: false,
              status: 404,
              json: async () => ({ error: { code: 'not_found', message: 'Not Found' } }),
            })
          : ok(options.schedule)
      }

      if (url.endsWith('/sessions')) {
        return ok(options.sessions ?? [])
      }

      if (url === '/api/programs') {
        return ok(options.programs ?? [])
      }

      return ok(options.clients ?? [ada])
    })

    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function renderAt(clientId: string) {
    return render(
      <MemoryRouter initialEntries={[`/clients/${clientId}`]}>
        <Routes>
          <Route path="/clients/:clientId" element={<ClientDetailScreen />} />
          <Route path="/clients" element={<p>roster</p>} />
        </Routes>
      </MemoryRouter>,
    )
  }

  function bodyOf(call: unknown[]): unknown {
    return JSON.parse(String((call[1] as RequestInit).body))
  }

  function callsOfMethod(fetchMock: ReturnType<typeof mockApi>, method: string) {
    return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method)
  }

  it('shows the client, their program, and their history', async () => {
    mockApi({
      clients: [ada, grace],
      programs: [gracesProgram, adasProgram],
      sessions: [session('2026-07-31', 'Shoulder tweaked on OHP.'), session('2026-07-29')],
      schedule,
    })
    renderAt('client-ada')

    expect(await screen.findByRole('heading', { name: 'Ada', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()

    // Another client's program does not appear on this client's screen.
    expect(screen.getByText('Winter Block')).toBeInTheDocument()
    expect(screen.queryByText('Grace Block')).not.toBeInTheDocument()

    expect(screen.getByText('Fri, 31 Jul 2026')).toBeInTheDocument()
    // The session comment is the v1 substitute for messaging, so it is on screen rather than
    // behind a tap.
    expect(screen.getByText('Shoulder tweaked on OHP.')).toBeInTheDocument()
  })

  // The program's title is the way into the builder, not a separate "Edit program" button
  // beside it (DESIGN.md §Controls: one way in per row). Pinned by accessible name, so this
  // also catches the title regressing back to a non-interactive <span>.
  it('links to the program builder from the program title', async () => {
    mockApi({ clients: [ada], programs: [adasProgram], schedule })
    renderAt('client-ada')

    const link = await screen.findByRole('link', { name: 'Winter Block' })
    expect(link).toHaveAttribute('href', '/programs/program-1')
    expect(link).toHaveClass('after:absolute', 'after:inset-0')
    expect(link.querySelector('[aria-hidden="true"]')).toHaveClass(
      'max-sm:absolute',
      'max-sm:right-0',
      'sm:static',
    )

    const row = link.closest('li')
    expect(row).toHaveClass(
      'relative',
      'isolate',
      'select-text',
      'max-sm:pr-6',
      'hover:bg-surface-sunk',
    )
  })

  it('unpacks the API’s HH:mm:ss into the time input', async () => {
    // #29 serializes TimeOnly as HH:mm:ss; an input handed that renders empty, which would show
    // a configured schedule as unset.
    mockApi({ clients: [ada], schedule })
    renderAt('client-ada')

    expect(await screen.findByLabelText('Send at')).toHaveValue('07:30')
    expect(screen.getByRole('checkbox', { name: 'Mon' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Wed' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Tue' })).not.toBeChecked()
  })

  it('sends seconds back, because HH:mm is a 400', async () => {
    // The single most breakable thing on this screen: #29 binds send_time to a TimeOnly, so
    // "08:15" is rejected and "08:15:00" is not.
    const fetchMock = mockApi({
      clients: [ada],
      schedule,
      onPatch: (_id, body) => ({ json: async () => ({ ...schedule, ...(body as object) }) }),
    })
    renderAt('client-ada')

    const time = await screen.findByLabelText('Send at')
    await userEvent.clear(time)
    await userEvent.type(time, '08:15')
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }))

    await screen.findByRole('status')
    const patches = callsOfMethod(fetchMock, 'PATCH')
    expect(patches).toHaveLength(1)
    expect(bodyOf(patches[0])).toMatchObject({ sendTime: '08:15:00' })
  })

  it('creates with POST when the client has no schedule at all', async () => {
    // GET answered 404, so there is no schedule id to PATCH. POST is the only route that makes
    // the first one.
    const created: ScheduleResponse = { ...schedule, sendTime: '06:00:00', daysOfWeek: [2, 4] }
    const fetchMock = mockApi({
      clients: [ada],
      schedule: null,
      onPost: () => ({ json: async () => created }),
    })
    renderAt('client-ada')

    expect(await screen.findByText(/No schedule yet/)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Send at'), '06:00')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tue' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Thu' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create schedule' }))

    const posts = callsOfMethod(fetchMock, 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0][0]).toBe('/api/clients/client-ada/schedule')
    expect(bodyOf(posts[0])).toEqual({ sendTime: '06:00:00', daysOfWeek: [2, 4], enabled: true })
    expect(callsOfMethod(fetchMock, 'PATCH')).toHaveLength(0)

    // And the form becomes an editor, so a second save patches rather than 409-ing.
    expect(await screen.findByRole('button', { name: 'Save schedule' })).toBeInTheDocument()
  })

  it('patches rather than posts when a schedule already exists', async () => {
    const fetchMock = mockApi({
      clients: [ada],
      schedule,
      onPatch: (_id, body) => ({ json: async () => ({ ...schedule, ...(body as object) }) }),
    })
    renderAt('client-ada')

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Sat' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }))

    const patches = callsOfMethod(fetchMock, 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0][0]).toBe('/api/schedules/schedule-1')
    expect(callsOfMethod(fetchMock, 'POST')).toHaveLength(0)
    // Days go up sorted, matching how #29 normalizes and stores them.
    expect(bodyOf(patches[0])).toMatchObject({ daysOfWeek: [1, 3, 5, 6] })
  })

  it('turns reminders back on after a deactivation switched them off', async () => {
    // The path #25 opens and never closes: deactivation disables the schedule in the same
    // transaction, and reactivation does not re-enable it. #50's reactivate control says the
    // trainer does it here, so here is where it has to work.
    const paused: ScheduleResponse = { ...schedule, enabled: false }
    const fetchMock = mockApi({
      clients: [ada],
      schedule: paused,
      onPatch: (_id, body) => ({ json: async () => ({ ...paused, ...(body as object) }) }),
    })
    renderAt('client-ada')

    expect(await screen.findByText(/Reminders are off/)).toBeInTheDocument()

    const toggle = screen.getByRole('checkbox', { name: 'Send these reminders' })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }))

    expect(bodyOf(callsOfMethod(fetchMock, 'PATCH')[0])).toMatchObject({ enabled: true })
    expect(await screen.findByRole('status')).toHaveTextContent('Sending Mon, Wed and Fri.')
  })

  it('still lets a deactivated client’s schedule be edited, and says why nothing sends', async () => {
    // #29 allows this deliberately: the worker re-checks users.is_active at send time, so an
    // edit can express intent for when they come back without leaking email in the meantime.
    const fetchMock = mockApi({
      clients: [{ ...ada, isActive: false }],
      schedule,
      onPatch: (_id, body) => ({ json: async () => ({ ...schedule, ...(body as object) }) }),
    })
    renderAt('client-ada')

    expect(await screen.findByText(/This client is deactivated/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Sun' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }))

    expect(callsOfMethod(fetchMock, 'PATCH')).toHaveLength(1)
  })

  it('refuses to save with no days picked, without asking the server', async () => {
    // Mirrors #29's own days_of_week check. Its message names a wire field, which means
    // nothing to someone looking at seven checkboxes.
    const fetchMock = mockApi({ clients: [ada], schedule: null })
    renderAt('client-ada')

    await userEvent.type(await screen.findByLabelText('Send at'), '06:00')
    await userEvent.click(screen.getByRole('button', { name: 'Create schedule' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Pick at least one day.')
    expect(callsOfMethod(fetchMock, 'POST')).toHaveLength(0)
  })

  it('refuses to save with no time picked', async () => {
    const fetchMock = mockApi({ clients: [ada], schedule: null })
    renderAt('client-ada')

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Mon' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create schedule' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Pick a time to send the reminder.')
    expect(callsOfMethod(fetchMock, 'POST')).toHaveLength(0)
  })

  it('clears the day complaint as soon as a day is picked', async () => {
    // #46's staleness rule: a message must not outlive the condition it describes. This one
    // named an empty day list and stayed put while the list stopped being empty.
    mockApi({ clients: [ada], schedule: null })
    renderAt('client-ada')

    await userEvent.type(await screen.findByLabelText('Send at'), '06:00')
    await userEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick at least one day.')

    await userEvent.click(screen.getByRole('checkbox', { name: 'Mon' }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears the time complaint as soon as a time is picked', async () => {
    // The same defect one field over, fixed with the same call rather than left for the next
    // bug report.
    mockApi({ clients: [ada], schedule: null })
    renderAt('client-ada')

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Mon' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick a time to send the reminder.')

    await userEvent.type(screen.getByLabelText('Send at'), '06:00')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('surfaces the server’s rejection and keeps the form as typed', async () => {
    mockApi({
      clients: [ada],
      schedule,
      onPatch: () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 'bad_request', message: 'days_of_week must be non-empty.' } }),
      }),
    })
    renderAt('client-ada')

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Sat' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('days_of_week must be non-empty.')
    expect(screen.getByRole('checkbox', { name: 'Sat' })).toBeChecked()
  })

  it('treats a client that is not on the roster as not found', async () => {
    // The roster is also the ownership check: another trainer's client is simply absent from
    // it, which is the same non-answer the API gives.
    mockApi({ clients: [grace] })
    renderAt('client-ada')

    expect(await screen.findByRole('heading', { name: 'Client not found', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to clients' })).toHaveAttribute('href', '/clients')
  })

  it('offers a retry when the screen cannot be loaded', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => (url === '/api/clients' ? [ada] : []),
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    renderAt('client-ada')

    expect(
      await screen.findByRole('heading', { name: 'We couldn’t load this client', level: 1 }),
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { name: 'Ada', level: 1 })).toBeInTheDocument()
  })

  it('says so when there is no program and nothing logged', async () => {
    mockApi({ clients: [ada], programs: [], sessions: [], schedule })
    renderAt('client-ada')

    expect(await screen.findByText(/No program yet/)).toBeInTheDocument()
    expect(screen.getByText('Nothing logged yet.')).toBeInTheDocument()

    const history = screen.getByRole('heading', { name: 'History' }).closest('section')!
    expect(within(history).queryByRole('listitem')).not.toBeInTheDocument()
  })
})
