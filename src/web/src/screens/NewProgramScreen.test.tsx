import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NewProgramScreen } from './NewProgramScreen'

describe('NewProgramScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockCreate(response: Partial<Response>) {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve({ ok: true, status: 201, json: async () => ({}), ...response }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function renderAt(search: string) {
    return render(
      <MemoryRouter initialEntries={[`/programs/new${search}`]}>
        <Routes>
          <Route path="/programs/new" element={<NewProgramScreen />} />
          <Route path="/programs/:programId" element={<p>builder</p>} />
          <Route path="/clients" element={<p>roster</p>} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('creates a draft for the client in the query string and opens the builder', async () => {
    // #51 links here as /programs/new?client=<id>, which is the only place the client id comes
    // from — a program cannot be created without one.
    const fetchMock = mockCreate({ json: async () => ({ id: 'program-9', clientId: 'client-ada' }) })
    renderAt('?client=client-ada')

    await userEvent.type(screen.getByLabelText('Name'), 'Winter Block')
    await userEvent.click(screen.getByRole('button', { name: 'Create program' }))

    expect(await screen.findByText('builder')).toBeInTheDocument()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/programs')
    // No status sent: the server defaults to draft, and a program that went active the moment
    // it was named would be a reminder email pointing at a program with no days in it.
    expect(JSON.parse(String(init.body))).toEqual({ clientId: 'client-ada', title: 'Winter Block' })
  })

  it('sends nobody to the API without a client', async () => {
    // A hand-typed or stale URL. POST would answer 400, but there is nothing on this form to
    // fix it with — a program belongs to a client and this screen cannot pick one.
    const fetchMock = mockCreate({})
    renderAt('')

    expect(screen.getByRole('heading', { name: 'Pick a client first', level: 1 })).toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a blank name without asking the server', async () => {
    const fetchMock = mockCreate({})
    renderAt('?client=client-ada')

    await userEvent.click(screen.getByRole('button', { name: 'Create program' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Give the program a name.')
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces the server’s rejection and keeps what was typed', async () => {
    mockCreate({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'unknown_client', message: 'Unknown client_id.' } }),
    })
    renderAt('?client=client-ada')

    await userEvent.type(screen.getByLabelText('Name'), 'Winter Block')
    await userEvent.click(screen.getByRole('button', { name: 'Create program' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown client_id.')
    expect(screen.getByLabelText('Name')).toHaveValue('Winter Block')
  })
})
