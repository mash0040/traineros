import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientResponse, ClientSessionResponse } from '../api/types.gen'
import { ClientsScreen } from './ClientsScreen'

const ada: ClientResponse = {
  id: 'client-ada',
  email: 'ada@example.com',
  displayName: 'Ada',
  timezone: 'America/Toronto',
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
}

const grace: ClientResponse = {
  id: 'client-grace',
  email: 'grace@example.com',
  displayName: 'Grace',
  timezone: 'Europe/Berlin',
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
}

function session(performedOn: string): ClientSessionResponse {
  return {
    id: `session-${performedOn}`,
    performedOn,
    programDayId: 'day-1',
    comment: null,
    createdAt: `${performedOn}T18:00:00Z`,
  }
}

describe('ClientsScreen', () => {
  beforeEach(() => {
    // The relative-age column is read against "today", so the clock is pinned. Without this the
    // test that asserts "3 days ago" starts failing three days after it was written.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /**
   * Routes each request by method and path, the way the real API would.
   *
   * Sessions default to "never trained" so a test only says what it cares about.
   */
  function mockApi(options: {
    clients?: ClientResponse[]
    sessions?: Record<string, ClientSessionResponse[]>
    onPost?: (body: unknown) => Partial<Response>
    onPatch?: (id: string, body: unknown) => Partial<Response>
  }) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const ok = (json: unknown, status = 200) =>
        Promise.resolve({ ok: true, status, json: async () => json })

      if (init?.method === 'POST') {
        const answer = options.onPost?.(JSON.parse(String(init.body)))
        return Promise.resolve({ ok: true, status: 201, json: async () => ({}), ...answer })
      }

      if (init?.method === 'PATCH') {
        const id = url.replace('/api/clients/', '')
        const answer = options.onPatch?.(id, JSON.parse(String(init.body)))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}), ...answer })
      }

      const sessionMatch = /^\/api\/clients\/([^/]+)\/sessions$/.exec(url)
      if (sessionMatch !== null) {
        return ok(options.sessions?.[sessionMatch[1]] ?? [])
      }

      return ok(options.clients ?? [])
    })

    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function renderScreen() {
    return render(
      <MemoryRouter>
        <ClientsScreen />
      </MemoryRouter>,
    )
  }

  function rowFor(name: string) {
    return screen.getByRole('row', { name: new RegExp(name) })
  }

  it('lists the roster with each client’s name and email', async () => {
    mockApi({ clients: [ada, grace] })
    renderScreen()

    expect(await screen.findByText('Ada')).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByText('Grace')).toBeInTheDocument()
  })

  it('shows how long ago each client last trained, which is the whole point of the column', async () => {
    // ui-ux.md calls this the "who's slacking" signal. A bare date makes the trainer do the
    // arithmetic; the age leads and the date backs it up.
    mockApi({
      clients: [ada, grace],
      sessions: {
        'client-ada': [session('2026-07-31'), session('2026-07-29')],
        'client-grace': [],
      },
    })
    renderScreen()

    // Awaited on the value rather than on the row: the row renders with the roster, and the
    // date lands one request later.
    expect(await screen.findByText('3 days ago')).toBeInTheDocument()

    const adaRow = rowFor('Ada')
    expect(within(adaRow).getByText('3 days ago')).toBeInTheDocument()
    // The exact date is still there, underneath.
    expect(within(adaRow).getByText('Fri, 31 Jul 2026')).toBeInTheDocument()

    // Never trained is a fact, not an empty cell.
    expect(within(rowFor('Grace')).getByText('No sessions yet')).toBeInTheDocument()
  })

  it('renders the roster before the last-session dates arrive', async () => {
    // The N requests are decision support, not the screen. Blocking the roster on them would
    // make adding a client wait for a column nobody is reading yet.
    let releaseSessions: (value: ClientSessionResponse[]) => void = () => {}
    const pending = new Promise<ClientSessionResponse[]>((keep) => {
      releaseSessions = keep
    })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        url.endsWith('/sessions')
          ? Promise.resolve({ ok: true, status: 200, json: async () => pending })
          : Promise.resolve({ ok: true, status: 200, json: async () => [ada] }),
      ),
    )
    renderScreen()

    expect(await screen.findByText('Ada')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a client' })).toBeInTheDocument()

    releaseSessions([session('2026-08-02')])
    expect(await screen.findByText('Yesterday')).toBeInTheDocument()
  })

  it('leaves the cell blank rather than claiming a client has never trained when the read fails', async () => {
    // A dropped request is not evidence of anything. Writing "No sessions yet" here would
    // accuse someone of slacking on the strength of a timeout.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        url.endsWith('/sessions')
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve({ ok: true, status: 200, json: async () => [ada] }),
      ),
    )
    renderScreen()

    expect(await screen.findByText('Ada')).toBeInTheDocument()
    expect(screen.queryByText('No sessions yet')).not.toBeInTheDocument()
    // And the roster itself is unharmed.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('asks one question per client and no more, however often it re-renders', async () => {
    const fetchMock = mockApi({
      clients: [ada, grace],
      sessions: { 'client-ada': [session('2026-08-01')], 'client-grace': [] },
    })
    renderScreen()

    await screen.findByText('2 days ago')

    const sessionCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/sessions'))
    expect(sessionCalls).toHaveLength(2)
  })

  it('adds a client and says plainly that no email was sent', async () => {
    // api.md: POST /api/clients "sends nothing (invite = trainer tells them to log in via
    // magic link)". A trainer who assumes an invite went out is a client who never hears
    // from anyone.
    const created: ClientResponse = { ...grace, id: 'client-new', displayName: 'Barbara', email: 'barbara@example.com' }
    const fetchMock = mockApi({
      clients: [ada],
      onPost: () => ({ json: async () => created }),
    })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Add a client' }))
    expect(screen.getByText(/No email is sent/)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Name'), 'Barbara')
    await userEvent.type(screen.getByLabelText('Email'), 'barbara@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add client' }))

    expect(await screen.findByText('Barbara added. Tell them to log in.')).toBeInTheDocument()
    expect(screen.getByText('barbara@example.com')).toBeInTheDocument()

    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toMatchObject({
      displayName: 'Barbara',
      email: 'barbara@example.com',
      // Defaulted from the browser rather than left empty: this value is what the reminder
      // scheduler sends against, so a blank or guessed zone emails someone at 4am.
      timezone: expect.any(String),
    })
  })

  it('keeps the typed address on screen when the email is already taken', async () => {
    // 409 email_taken is the one rejection the trainer can act on, so its message is shown
    // rather than replaced, and nothing they typed is thrown away.
    mockApi({
      clients: [ada],
      onPost: () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'email_taken', message: 'A user with this email already exists.' } }),
      }),
    })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Add a client' }))
    await userEvent.type(screen.getByLabelText('Name'), 'Ada Again')
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add client' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A user with this email already exists.')
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com')
  })

  it('confirms before deactivating, and names the side effect the trainer would not predict', async () => {
    // #25 disables the client's reminder schedules in the same transaction. That is the part
    // worth warning about — the flag itself is reversible from this screen, the reminders
    // are not.
    const fetchMock = mockApi({
      clients: [ada],
      onPatch: () => ({ json: async () => ({ ...ada, isActive: false }) }),
    })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate Ada' }))

    expect(screen.getByText('Deactivate Ada? Their reminder emails stop too.')).toBeInTheDocument()
    // Nothing has been written yet.
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }))

    expect(await screen.findByText('Deactivated')).toBeInTheDocument()
    const patches = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0][0]).toBe('/api/clients/client-ada')
    expect(JSON.parse(String((patches[0][1] as RequestInit).body))).toEqual({ isActive: false })
  })

  it('lets the confirmation be cancelled without writing anything', async () => {
    const fetchMock = mockApi({ clients: [ada] })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate Ada' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('button', { name: 'Deactivate Ada' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toHaveLength(0)
  })

  it('offers reactivation without selling it as an undo', async () => {
    // The API has both directions, so a one-way control would make a mis-click unrecoverable
    // from this screen. But deactivating switched their reminders off and reactivating does
    // not switch them back on, so the row says so.
    const deactivated = { ...ada, isActive: false }
    const fetchMock = mockApi({
      clients: [deactivated],
      onPatch: () => ({ json: async () => ({ ...ada, isActive: true }) }),
    })
    renderScreen()

    expect(await screen.findByText('Reminders stay off until you turn them back on.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Reactivate Ada' }))

    expect(await screen.findByText('Active')).toBeInTheDocument()
    const patches = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    expect(JSON.parse(String((patches[0][1] as RequestInit).body))).toEqual({ isActive: true })
  })

  it('keeps a deactivated client on the roster', async () => {
    // Hiding them would make reactivation impossible from the only screen that lists clients.
    mockApi({ clients: [{ ...ada, isActive: false }, grace] })
    renderScreen()

    expect(await screen.findByText('Ada')).toBeInTheDocument()
    expect(screen.getByText('Deactivated')).toBeInTheDocument()
  })

  it('offers a retry when the roster cannot be loaded', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ok: true, status: 200, json: async () => [ada] })
    vi.stubGlobal('fetch', fetchMock)
    renderScreen()

    expect(
      await screen.findByRole('heading', { name: 'We couldn’t load your clients', level: 2 }),
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Ada')).toBeInTheDocument()
  })

  it('treats an empty roster as an empty state, not an error', async () => {
    mockApi({ clients: [] })
    renderScreen()

    expect(await screen.findByText(/No clients yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a client' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })
})
