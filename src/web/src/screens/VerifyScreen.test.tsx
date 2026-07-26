import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VerifyScreen } from './VerifyScreen'

describe('VerifyScreen', () => {
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

  function renderAt(token: string) {
    return render(
      <MemoryRouter initialEntries={[`/verify?token=${token}`]}>
        <Routes>
          <Route path="/verify" element={<VerifyScreen />} />
          <Route path="/" element={<p>signed in</p>} />
          <Route path="/login" element={<p>login</p>} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('validates on load without consuming the token', async () => {
    // The invariant that makes the two-step flow worth having: mail scanners and link
    // prefetchers open this URL before the client does. If the page ever POSTs on mount,
    // every scanned inbox gets a dead link and the client taps a broken button.
    const fetchMock = mockFetch(() => ({ json: async () => ({ valid: true }) }))
    renderAt('good-token')

    await screen.findByRole('heading', { name: 'Welcome back' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined]
    expect(url).toBe('/api/auth/verify?token=good-token')
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('consumes the token only when the button is pressed', async () => {
    const fetchMock = mockFetch((_url, init) =>
      init?.method === 'POST' ? { json: async () => ({ ok: true }) } : { json: async () => ({ valid: true }) },
    )
    renderAt('good-token')

    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))

    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0][0]).toBe('/api/auth/verify')
    expect(posts[0][1]).toMatchObject({ body: JSON.stringify({ token: 'good-token' }) })
    // Landed on the authenticated route, which re-reads auth state from the server itself.
    expect(await screen.findByText('signed in')).toBeInTheDocument()
  })

  it('offers a new link when the token is spent, without saying which way it failed', async () => {
    // #21 collapses expired, used, and forged into one answer. The copy has to cover all
    // three, so it names the rules rather than the cause.
    mockFetch(() => ({ json: async () => ({ valid: false }) }))
    renderAt('spent-token')

    expect(await screen.findByRole('heading', { name: 'This link no longer works' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Get a new link' })).toHaveAttribute('href', '/login')
  })

  it('says the link could not be checked when the request fails, not that it expired', async () => {
    // A dropped request is not a spent token. Telling the client their link died would send
    // them to request a replacement over the same broken connection.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderAt('good-token')

    expect(await screen.findByRole('heading', { name: 'We couldn’t check your link' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'This link no longer works' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('treats a missing token as a dead link without calling the API', async () => {
    const fetchMock = mockFetch(() => ({}))
    renderAt('')

    expect(await screen.findByRole('heading', { name: 'This link no longer works' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
