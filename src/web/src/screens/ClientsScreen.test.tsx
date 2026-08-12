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

  // Was getByRole('row'). #135 took the roster off <table> — a table cannot reflow at 390px —
  // so a row is now an <li> in the roster list. Scoped from the name link rather than by index,
  // which keeps the helper indifferent to how the row is laid out: the columns exist only from
  // sm: up, and nothing here should have an opinion about that.
  function rowFor(name: string) {
    const row = screen.getByRole('link', { name }).closest('li')
    if (row === null) {
      throw new Error(`No roster row for ${name}`)
    }
    return row
  }

  it('lists the roster with each client’s name and email', async () => {
    mockApi({ clients: [ada, grace] })
    renderScreen()

    expect(await screen.findByText('Ada')).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByText('Grace')).toBeInTheDocument()
  })

  // The name is the way into the client, and the chevron beside it is decoration for the eye
  // only. Matching on the accessible name pins that: drop the aria-hidden on RecordLink's glyph
  // and every client in the roster is announced as "Ada ›", which is what a trainer using a
  // screen reader would hear on every row.
  it('opens the client from the name, and the chevron stays out of the accessible name', async () => {
    mockApi({ clients: [ada, grace] })
    renderScreen()

    expect(await screen.findByRole('link', { name: 'Ada' })).toHaveAttribute(
      'href',
      '/clients/client-ada',
    )
  })

  // #135. The roster was a <table>, which has a fixed layout algorithm and so cannot reflow:
  // four columns of real content on a 390px viewport either overflow or crush, at every width.
  // The columns now come from a grid that exists only from sm: up.
  //
  // Whether the columns *look* right is a layout question and the human's to judge — jsdom
  // loads no stylesheet. What is assertable without one is the structure the fix depends on,
  // which is also the thing a later refactor would quietly undo.
  it('renders the roster as a list, not a table, so it can reflow on a phone', async () => {
    mockApi({ clients: [ada, grace] })
    renderScreen()
    await screen.findByText('Ada')

    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    const roster = screen.getByRole('list', { name: /Your clients/ })
    expect(within(roster).getAllByRole('listitem')).toHaveLength(2)
  })

  // The other half of #135: the client's name left the visible label and went to aria-label.
  // Both halves matter and they pull in opposite directions, so both are asserted here — the
  // eye gets a button that fits a 390px card, and a screen reader going down the roster still
  // hears which client each control belongs to, because a linear reading has no other way to
  // know. Shortening the label without the aria-label would be a regression dressed as a fix.
  it('keeps the client’s name in the accessible name of the deactivate control, not in its visible text', async () => {
    mockApi({ clients: [ada] })
    renderScreen()

    const deactivate = await screen.findByRole('button', { name: 'Deactivate Ada' })
    expect(deactivate).toHaveTextContent(/^Deactivate$/)
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

    // The SPA's copy for email_taken, not the server's "A user with this email already exists."
    // The server's sentence is true and unhelpful: it describes a row, when what the trainer
    // needs is the next move, which is to go and look at their own roster.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email is already in use. Check whether they are already on your roster.',
    )
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com')
    // Still attributed to the email field, because this rejection genuinely is about it.
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
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

  it('refuses a malformed address without asking the server', async () => {
    // #114 item 3. The form carries noValidate, so nothing but this check stands between a
    // typo and a POST — and the message has to be in the page rather than a native bubble,
    // which is what "failing silently" was.
    const fetchMock = mockApi({ clients: [ada] })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Add a client' }))
    await userEvent.type(screen.getByLabelText('Name'), 'Ada')
    await userEvent.type(screen.getByLabelText('Email'), 'Ada <ada@example.com>')
    await userEvent.click(screen.getByRole('button', { name: 'Add client' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Please enter a valid email address.')
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    // The message is attached to the field it is about, and to no other.
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(
      'Please enter a valid email address.',
    )
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'false')
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(0)
    // Nothing typed is thrown away — the whole point is that it can be corrected.
    expect(screen.getByLabelText('Email')).toHaveValue('Ada <ada@example.com>')
  })

  it('points a missing name at the name field, not the email field', async () => {
    // The bug the field-tagged error shape exists to prevent: one `error` string marked every
    // input invalid, so a screen reader sent the trainer to fix an address that was fine.
    mockApi({ clients: [ada] })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Add a client' }))
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add client' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter their name.')
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false')
  })

  it('surfaces the server’s rejection for an address the form let through', async () => {
    // The client rule is looser than the server's on purpose, so this path is expected traffic
    // rather than an edge case: the server is the authority and its message is what shows.
    //
    // Both layers now word this rejection identically, which is the point for the trainer and
    // a problem for this test — the message alone no longer proves which layer produced it.
    // So the request itself is the assertion: the POST going out is what says the form let the
    // address through, and the alert is what says the answer came back and landed on screen.
    const fetchMock = mockApi({
      clients: [ada],
      onPost: () => ({
        ok: false,
        status: 400,
        // Verbatim from ClientEndpoints.CreateClient.
        json: async () => ({
          error: { code: 'bad_request', message: 'Please enter a valid email address.' },
        }),
      }),
    })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Add a client' }))
    await userEvent.type(screen.getByLabelText('Name'), 'Ada')
    // Passes looksLikeEmail, refused by EmailAddresses.IsValid.
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example..com')
    await userEvent.click(screen.getByRole('button', { name: 'Add client' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Please enter a valid email address.')
    expect(
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toHaveLength(1)
    expect(screen.queryByText(/added\. Tell them to log in\./)).not.toBeInTheDocument()
  })

  it('closes the add form from the disclosure, with no second completion path in the form', async () => {
    // #114 item 4. "Done" sat beside "Add client" and read as a second way to finish the form.
    // It is gone rather than renamed "Cancel", because after a successful add there is nothing
    // to cancel — see the toggle in ClientsScreen.tsx.
    mockApi({ clients: [ada] })
    renderScreen()

    const toggle = await screen.findByRole('button', { name: 'Add a client' })
    await userEvent.click(toggle)

    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(close)

    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a client' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the form open after adding, so the next client is one form away', async () => {
    // The state that makes "Cancel" the wrong label: the add already happened and the form is
    // standing open for another.
    const created: ClientResponse = { ...grace, id: 'client-new', displayName: 'Barbara', email: 'barbara@example.com' }
    mockApi({ clients: [ada], onPost: () => ({ json: async () => created }) })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Add a client' }))
    await userEvent.type(screen.getByLabelText('Name'), 'Barbara')
    await userEvent.type(screen.getByLabelText('Email'), 'barbara@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add client' }))

    await screen.findByText('Barbara added. Tell them to log in.')
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    // Emptied and ready, not closed.
    expect(screen.getByLabelText('Email')).toHaveValue('')
  })

  it('treats an empty roster as an empty state, not an error', async () => {
    mockApi({ clients: [] })
    renderScreen()

    expect(await screen.findByText(/No clients yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a client' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })
})
