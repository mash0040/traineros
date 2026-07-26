import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LoginScreen } from './LoginScreen'

// The suite is deliberately narrow. It covers the two client-side behaviours that are
// security-shaped and would regress silently: the unconditional sent state, and (in
// VerifyScreen.test.tsx) not consuming a token on load. Everything else about these screens
// is verified in a browser, per ui-ux.md's "exactly the design effort required" rule.
describe('LoginScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockFetch(response: Partial<Response>) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ ok: true }),
      ...response,
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('shows the same confirmation whether or not the address has an account', async () => {
    // The API answers 202 for both cases (api.md #20). Two runs, byte-identical UI: if a
    // future change branches on the response, these two assertions stop matching.
    const rendered: string[] = []

    for (const email of ['known@example.com', 'never-heard-of-them@example.com']) {
      mockFetch({})
      const view = render(<LoginScreen />)

      await userEvent.type(screen.getByLabelText('Email'), email)
      await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }))

      const heading = await screen.findByRole('heading', { name: 'Check your email' })
      // Strip the echoed address, which is the client's own input rather than a signal
      // about the account.
      rendered.push(heading.closest('div')!.textContent!.replace(email, '{email}'))
      view.unmount()
    }

    expect(rendered[0]).toEqual(rendered[1])
    expect(rendered[0]).toContain('has an account')
  })

  it('posts the address exactly once even if the button is double tapped', async () => {
    // ui-ux.md disable-on-tap. The endpoint allows three sends per address per 15 minutes,
    // so a stray second tap costs the client a third of their budget.
    const fetchMock = mockFetch({})
    render(<LoginScreen />)

    await userEvent.type(screen.getByLabelText('Email'), 'client@example.com')
    const button = screen.getByRole('button', { name: 'Email me a link' })
    await userEvent.dblClick(button)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/magic-link',
      expect.objectContaining({
        method: 'POST',
        // httpOnly cookie: the browser attaches it only when told to.
        credentials: 'same-origin',
        body: JSON.stringify({ email: 'client@example.com' }),
      }),
    )
  })

  it('surfaces a rate-limit rejection instead of claiming the mail was sent', async () => {
    mockFetch({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: 'rate_limited', message: 'Too many requests. Try again later.' } }),
    })
    render(<LoginScreen />)

    await userEvent.type(screen.getByLabelText('Email'), 'client@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests. Try again later.')
    expect(screen.queryByRole('heading', { name: 'Check your email' })).not.toBeInTheDocument()
  })
})
