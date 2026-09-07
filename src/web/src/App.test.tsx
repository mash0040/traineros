import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App'

// The route table's role dispatch, added in #50 when the trainer got screens of their own.
//
// Worth its own file rather than folding into a screen test: which role lands where is decided
// entirely by the two gates in App.tsx, and neither screen can see the decision that routed to
// it. These are also the closest thing the SPA has to a security-shaped invariant — not the
// enforcement, which is server-side on every route, but the promise that the app never puts one
// role in front of the other's screens.
describe('App routing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const me = {
    id: 'client-1',
    displayName: 'Ada',
    email: 'ada@example.com',
    timezone: 'America/Toronto',
    activeProgram: null,
  }

  /**
   * `role` decides what GET /api/me answers, which is the only signal the SPA has.
   *
   * A trainer holds a valid session and still gets 404 from it, because the route is
   * client-only. That 404 is not an error here, it is the identification.
   */
  function mockSession(role: 'trainer' | 'client' | 'anonymous') {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === '/api/me') {
          if (role === 'client') {
            return Promise.resolve({ ok: true, status: 200, json: async () => me })
          }
          const status = role === 'trainer' ? 404 : 401
          return Promise.resolve({
            ok: false,
            status,
            json: async () => ({ error: { code: 'not_found', message: 'Not Found' } }),
          })
        }

        if (url === '/api/clients') {
          return Promise.resolve({ ok: true, status: 200, json: async () => [] })
        }

        // Whatever the landed-on screen asks for next.
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ program: null }) })
      }),
    )
  }

  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )
  }

  it('sends a trainer landing on the client home to their own screens', async () => {
    // #42 parked a "trainer dashboard arrives later" placeholder here. #50 is the later.
    mockSession('trainer')
    renderAt('/')

    expect(await screen.findByRole('heading', { name: 'Clients', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument()
  })

  it('does not put a client in front of the trainer roster', async () => {
    mockSession('client')
    renderAt('/clients')

    expect(await screen.findByRole('heading', { name: 'Today', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Clients' })).not.toBeInTheDocument()
  })

  it('sends an anonymous visitor on a trainer path to log in', async () => {
    // Not an error page and not the roster's own empty state: no session is routing
    // information, the same as it is on the client side.
    mockSession('anonymous')
    renderAt('/clients')

    expect(await screen.findByRole('heading', { name: 'Log in', level: 1 })).toBeInTheDocument()
  })

  it('leaves the client home to the client', async () => {
    mockSession('client')
    renderAt('/')

    expect(await screen.findByRole('heading', { name: 'Today', level: 1 })).toBeInTheDocument()
  })

  it('sets a specific title for an auth route', async () => {
    renderAt('/login')

    await waitFor(() => expect(document.title).toBe('Log In | TrainerOS'))
  })

  it('updates the title after a role redirect', async () => {
    mockSession('anonymous')
    renderAt('/clients')

    expect(await screen.findByRole('heading', { name: 'Log in', level: 1 })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('Log In | TrainerOS'))
  })
})
