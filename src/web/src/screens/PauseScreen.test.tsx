import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PauseScreen } from './PauseScreen'

describe('PauseScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockFetch(handler: (url: string, init?: RequestInit) => Partial<Response>) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const response = handler(url, init)
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}), ...response })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  /** A rejection as the API shapes it: 401 invalid_token, identical for every cause (#40). */
  function invalidToken(): Partial<Response> {
    return {
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'invalid_token', message: 'This pause link is invalid or expired.' } }),
    }
  }

  function renderAt(token: string) {
    return render(
      <MemoryRouter initialEntries={[`/pause?token=${token}`]}>
        <Routes>
          <Route path="/pause" element={<PauseScreen />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  function posts(fetchMock: ReturnType<typeof mockFetch>) {
    return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
  }

  it('validates on load and pauses nothing', async () => {
    // The invariant the whole two-step flow exists for (notifications.md resolved question 2):
    // mail scanners and link prefetchers GET this URL before the client ever opens the email.
    // If mount ever writes, every client behind a scanning mail provider is silently paused,
    // and the symptom is email that stops arriving — nobody reports that as a bug.
    const fetchMock = mockFetch(() => ({ json: async () => ({ valid: true }) }))
    renderAt('good-token')

    await screen.findByRole('heading', { name: 'Pause reminder emails?' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined]
    expect(url).toBe('/api/pause?token=good-token')
    expect(init?.method ?? 'GET').toBe('GET')
    expect(posts(fetchMock)).toHaveLength(0)
  })

  it('pauses only when the button is pressed, and says so afterwards', async () => {
    const fetchMock = mockFetch((_url, init) =>
      init?.method === 'POST' ? { json: async () => ({ ok: true }) } : { json: async () => ({ valid: true }) },
    )
    renderAt('good-token')

    await userEvent.click(await screen.findByRole('button', { name: 'Pause reminders' }))

    expect(await screen.findByRole('heading', { name: 'Reminders paused' })).toBeInTheDocument()
    expect(posts(fetchMock)).toHaveLength(1)
    expect(posts(fetchMock)[0][0]).toBe('/api/pause')
    expect(posts(fetchMock)[0][1]).toMatchObject({ body: JSON.stringify({ token: 'good-token' }) })
    // Terminal: the control that writes is gone, so a second press cannot happen by reflex.
    expect(screen.queryByRole('button', { name: 'Pause reminders' })).not.toBeInTheDocument()
  })

  it('reads the same after pausing a schedule that was already paused', async () => {
    // #40 keeps the POST a plain no-op update, so an already-paused schedule answers 200 like
    // any other and the client cannot tell the two apart. The copy therefore describes the
    // state she is now in rather than claiming this press is what changed it.
    const fetchMock = mockFetch((_url, init) =>
      init?.method === 'POST' ? { json: async () => ({ ok: true }) } : { json: async () => ({ valid: true }) },
    )
    renderAt('already-paused-token')

    await userEvent.click(await screen.findByRole('button', { name: 'Pause reminders' }))

    expect(await screen.findByRole('heading', { name: 'Reminders paused' })).toBeInTheDocument()
    // Who can undo it: notifications.md makes re-enabling the trainer's job, not a second
    // token flow, so a client left to infer that would have nowhere to go.
    expect(screen.getByText(/Ask your trainer/)).toBeInTheDocument()
    expect(posts(fetchMock)).toHaveLength(1)
  })

  it('gives one answer for a dead link, without saying which way it died', async () => {
    // Forged, expired, and schedule-since-deleted are one indistinguishable answer by design.
    mockFetch(() => ({ json: async () => ({ valid: false }) }))
    renderAt('spent-token')

    expect(await screen.findByRole('heading', { name: 'This link no longer works' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause reminders' })).not.toBeInTheDocument()
  })

  it('says the link could not be checked when the request fails, not that it expired', async () => {
    // The #42 distinction, and it matters more here than there: there is no way to request a
    // replacement pause link. Telling her it is dead over flaky wifi leaves her waiting for the
    // next reminder email, which is the email she is trying to stop.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderAt('good-token')

    expect(await screen.findByRole('heading', { name: 'We couldn’t check your link' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'This link no longer works' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('re-checks the link when the retry is pressed', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ valid: true }) })
    vi.stubGlobal('fetch', fetchMock)
    renderAt('good-token')

    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { name: 'Pause reminder emails?' })).toBeInTheDocument()
    // Still a GET. The retry path must not be the one that starts mutating on load.
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === undefined)).toBe(true)
  })

  it('keeps the button live when the press cannot reach the server', async () => {
    // Nothing was paused, so the screen must not move to the paused state, and must not claim
    // the link is finished either. She stays where she was with a message and a live button.
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve({ ok: true, status: 200, json: async () => ({ valid: true }) }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderAt('good-token')

    await userEvent.click(await screen.findByRole('button', { name: 'Pause reminders' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Pause reminder emails?' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Reminders paused' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'This link no longer works' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pause reminders' })).toBeEnabled()
  })

  it('shows the dead-link state when the token dies between the check and the press', async () => {
    // The one gap the two-step flow opens: 30 days is a long time to sit on a confirmation
    // page. A 401 on the POST is the server saying the token stopped working in between.
    mockFetch((_url, init) =>
      init?.method === 'POST' ? invalidToken() : { json: async () => ({ valid: true }) },
    )
    renderAt('good-token')

    await userEvent.click(await screen.findByRole('button', { name: 'Pause reminders' }))

    expect(await screen.findByRole('heading', { name: 'This link no longer works' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Reminders paused' })).not.toBeInTheDocument()
  })

  it('treats a missing token as a dead link without calling the API', async () => {
    const fetchMock = mockFetch(() => ({}))
    renderAt('')

    expect(await screen.findByRole('heading', { name: 'This link no longer works' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
