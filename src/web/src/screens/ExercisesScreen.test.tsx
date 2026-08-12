import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExerciseResponse } from '../api/types.gen'
import { ExercisesScreen } from './ExercisesScreen'

const squat: ExerciseResponse = {
  id: 'ex-1',
  name: 'Back Squat',
  videoUrl: 'https://www.youtube.com/watch?v=squat',
  cues: 'Chest up, knees out.',
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
}

const bench: ExerciseResponse = {
  id: 'ex-2',
  name: 'Bench Press',
  videoUrl: null,
  cues: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
}

const sissy: ExerciseResponse = {
  id: 'ex-3',
  name: 'Sissy Squat',
  videoUrl: 'https://www.youtube.com/watch?v=sissy',
  cues: 'Retired, but a client logged it last winter.',
  isActive: false,
  createdAt: '2026-01-01T00:00:00Z',
}

describe('ExercisesScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Routes by method and path, the way the real API would. */
  function mockApi(options: {
    library?: ExerciseResponse[]
    onPost?: (body: unknown) => Partial<Response>
    onPatch?: (id: string, body: unknown) => Partial<Response>
    listFails?: boolean
  }) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const answer = options.onPost?.(JSON.parse(String(init.body)))
        return Promise.resolve({ ok: true, status: 201, json: async () => ({}), ...answer })
      }

      if (init?.method === 'PATCH') {
        const id = url.replace('/api/exercises/', '')
        const answer = options.onPatch?.(id, JSON.parse(String(init.body)))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}), ...answer })
      }

      if (options.listFails === true) {
        return Promise.reject(new TypeError('Failed to fetch'))
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => options.library ?? [],
      })
    })

    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function renderScreen() {
    // Entered at its own path so the shell's aria-current has something true to say.
    return render(
      <MemoryRouter initialEntries={['/exercises']}>
        <ExercisesScreen />
      </MemoryRouter>,
    )
  }

  /** One exercise's row, so an assertion cannot accidentally match another row's copy. */
  function rowByHeading(name: string) {
    const heading = screen.getByRole('heading', { name: new RegExp(`^${name}`) })
    const item = heading.closest('li')
    if (item === null) {
      throw new Error(`No row for ${name}`)
    }
    return item
  }

  /** The body of the last PATCH sent, parsed. */
  function lastPatchBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
    const patches = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'PATCH',
    )
    const last = patches.at(-1)
    if (last === undefined) {
      throw new Error('No PATCH was sent')
    }
    return JSON.parse(String((last[1] as RequestInit).body))
  }

  it('lists the library with each exercise’s cues', async () => {
    mockApi({ library: [squat, bench] })
    renderScreen()

    expect(await screen.findByRole('heading', { name: /^Back Squat/ })).toBeInTheDocument()
    expect(screen.getByText('Chest up, knees out.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^Bench Press/ })).toBeInTheDocument()
  })

  it('links the video out to YouTube in a new tab rather than embedding it', async () => {
    // ui-ux.md: "Video links open YouTube in a new tab/native app. No embedded player."
    mockApi({ library: [squat] })
    renderScreen()

    const link = await screen.findByRole('link', { name: /Watch demo/ })
    expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=squat')
    expect(link).toHaveAttribute('target', '_blank')
    // Not optional on a cross-origin target=_blank.
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('shows retired exercises so they can be brought back', async () => {
    // GET /api/exercises returns both, deliberately (#26). A library that hid the retired ones
    // would make restore unreachable and the row invisible to the trainer who retired it.
    mockApi({ library: [squat, sissy] })
    renderScreen()
    await screen.findByRole('heading', { name: /^Back Squat/ })

    const retired = rowByHeading('Sissy Squat')
    expect(within(retired).getByText('Retired')).toBeInTheDocument()
    expect(within(retired).getByRole('button', { name: 'Restore Sissy Squat' })).toBeInTheDocument()
    // An active row offers the opposite control and no badge.
    const active = rowByHeading('Back Squat')
    expect(within(active).queryByText('Retired')).not.toBeInTheDocument()
    expect(within(active).getByRole('button', { name: 'Retire Back Squat' })).toBeInTheDocument()
  })

  // #135. "Retire Jumping Jacks" and "Edit Jumping Jacks" side by side in a shrink-0 group was
  // the overflow that opened the issue: laid out at max-content inside a card with ~294px to
  // give at 390px, the group hung over the right edge. The naming form moved to aria-label.
  //
  // The overflow itself needs a browser to see. This is the invariant underneath it: the row
  // controls read as one word and are announced with the exercise they act on. The test above
  // already matches on the accessible name, so this asserts the half that could silently rot —
  // someone "simplifying" the aria-label away would still pass every other test in this file.
  it('names the exercise in the row controls’ accessible names, not in their visible labels', async () => {
    mockApi({ library: [squat, sissy] })
    renderScreen()
    await screen.findByRole('heading', { name: /^Back Squat/ })

    const active = rowByHeading('Back Squat')
    expect(within(active).getByRole('button', { name: 'Retire Back Squat' })).toHaveTextContent(
      /^Retire$/,
    )
    expect(within(active).getByRole('button', { name: 'Edit Back Squat' })).toHaveTextContent(
      /^Edit$/,
    )

    const retired = rowByHeading('Sissy Squat')
    expect(within(retired).getByRole('button', { name: 'Restore Sissy Squat' })).toHaveTextContent(
      /^Restore$/,
    )
  })

  it('confirms a retire by saying what survives it', async () => {
    // The word "retire" does not tell a trainer what happens to work already done, which is the
    // only question worth asking before pressing it.
    mockApi({ library: [squat] })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Retire Back Squat' }))

    const prompt = screen.getByRole('group')
    expect(within(prompt).getByText(/Programs already using it keep it/)).toBeInTheDocument()
    expect(within(prompt).getByText(/logged sets stay exactly as they are/)).toBeInTheDocument()
  })

  it('retires with a PATCH that touches nothing but isActive', async () => {
    // The load-bearing assertion on this screen. #26 reads "" as "clear this field", so a retire
    // that also sent the text fields would wipe the video URL and cues of any exercise whose
    // form state happened to be empty. There is no DELETE route; this PATCH is the delete.
    const fetchMock = mockApi({
      library: [squat],
      onPatch: (id, body) => ({
        json: async () => ({ ...squat, id, ...(body as object) }),
      }),
    })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Retire Back Squat' }))
    await user.click(screen.getByRole('button', { name: 'Retire' }))

    expect(await screen.findByText('Retired')).toBeInTheDocument()
    expect(lastPatchBody(fetchMock)).toEqual({ isActive: false })
    // Spelled out, because "toEqual" passing on a body with extra undefined keys would be the
    // exact bug this test exists to catch.
    expect(Object.keys(lastPatchBody(fetchMock) as object)).toEqual(['isActive'])
  })

  it('restores a retired exercise in one press, with no confirmation', async () => {
    // Nothing is lost by restoring, so there is nothing to warn about.
    const fetchMock = mockApi({
      library: [sissy],
      onPatch: (id, body) => ({ json: async () => ({ ...sissy, id, ...(body as object) }) }),
    })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Restore Sissy Squat' }))

    expect(await screen.findByRole('button', { name: 'Retire Sissy Squat' })).toBeInTheDocument()
    expect(lastPatchBody(fetchMock)).toEqual({ isActive: true })
  })

  it('edits name, video and cues in one save', async () => {
    const fetchMock = mockApi({
      library: [squat],
      onPatch: (id, body) => ({ json: async () => ({ ...squat, id, ...(body as object) }) }),
    })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Edit Back Squat' }))

    const nameField = screen.getByLabelText('Name')
    await user.clear(nameField)
    await user.type(nameField, 'High-Bar Squat')
    const cues = screen.getByLabelText('Cues')
    await user.clear(cues)
    await user.type(cues, 'Elbows down.')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('heading', { name: /^High-Bar Squat/ })).toBeInTheDocument()
    expect(screen.getByText('Elbows down.')).toBeInTheDocument()
    expect(lastPatchBody(fetchMock)).toEqual({
      name: 'High-Bar Squat',
      videoUrl: 'https://www.youtube.com/watch?v=squat',
      cues: 'Elbows down.',
    })
  })

  it('clears a video URL by emptying the field, which the blank-means-null rule allows', async () => {
    // #26's escape hatch is the only way to wipe a nullable field, since an omitted key means
    // "leave alone". If the edit form dropped empty strings, the video link would be one-way.
    const fetchMock = mockApi({
      library: [squat],
      onPatch: (id, body) => ({
        json: async () => ({ ...squat, id, ...(body as object), videoUrl: null }),
      }),
    })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Edit Back Squat' }))
    await user.clear(screen.getByLabelText('Video URL'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('button', { name: 'Edit Back Squat' })).toBeInTheDocument()
    expect(lastPatchBody(fetchMock)).toMatchObject({ videoUrl: '' })
    expect(screen.queryByRole('link', { name: /Watch demo/ })).not.toBeInTheDocument()
  })

  it('adds an exercise and puts it in name order rather than at the end', async () => {
    // The list a trainer is looking at should be the one a reload gives back.
    mockApi({
      library: [bench, sissy],
      onPost: (body) => ({
        json: async () => ({
          id: 'ex-new',
          isActive: true,
          createdAt: '2026-08-05T00:00:00Z',
          ...(body as object),
        }),
      }),
    })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Add an exercise' }))
    await user.type(screen.getByLabelText('Name'), 'Back Squat')
    await user.click(screen.getByRole('button', { name: 'Add exercise' }))

    expect(await screen.findByText(/Back Squat added/)).toBeInTheDocument()
    // Scoped to the list, so the add form's own heading is not read as a row.
    const names = within(screen.getByRole('list', { name: 'Your exercises' }))
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent)
    expect(names).toEqual(['Back Squat', 'Bench Press', 'Sissy SquatRetired'])
  })

  it('refuses a video URL the browser would read as a relative path', async () => {
    // "youtube.com/watch?v=x" stores fine and then renders as an href, which sends the client
    // to a route inside the app instead of to YouTube. The server does not check this at all.
    const fetchMock = mockApi({ library: [] })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Add an exercise' }))
    await user.type(screen.getByLabelText('Name'), 'Back Squat')
    await user.type(screen.getByLabelText('Video URL'), 'youtube.com/watch?v=squat')
    await user.click(screen.getByRole('button', { name: 'Add exercise' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a full link starting with https://, or leave it empty.',
    )
    // Attributed to the field it is about, and only that field.
    expect(screen.getByLabelText('Video URL')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'false')
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false)
  })

  it('refuses a javascript: URL, which parses but is not a link', async () => {
    const fetchMock = mockApi({ library: [] })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Add an exercise' }))
    await user.type(screen.getByLabelText('Name'), 'Back Squat')
    await user.type(screen.getByLabelText('Video URL'), 'javascript:alert(1)')
    await user.click(screen.getByRole('button', { name: 'Add exercise' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/full link starting with https/)
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false)
  })

  it('accepts a non-YouTube link, because the field is about the link working', async () => {
    // ui-ux.md describes where these links go, not what the field accepts. A self-hosted video
    // is not a mistake.
    const fetchMock = mockApi({
      library: [],
      onPost: (body) => ({
        json: async () => ({ id: 'ex-new', isActive: true, ...(body as object) }),
      }),
    })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Add an exercise' }))
    await user.type(screen.getByLabelText('Name'), 'Sled Push')
    await user.type(screen.getByLabelText('Video URL'), 'https://vimeo.com/123')
    await user.click(screen.getByRole('button', { name: 'Add exercise' }))

    expect(await screen.findByText(/Sled Push added/)).toBeInTheDocument()
    const posts = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST',
    )
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toMatchObject({
      videoUrl: 'https://vimeo.com/123',
    })
  })

  it('requires a name before spending a round trip on it', async () => {
    const fetchMock = mockApi({ library: [] })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Add an exercise' }))
    await user.click(screen.getByRole('button', { name: 'Add exercise' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Give the exercise a name.')
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false)
  })

  it('clears a validation message once the trainer starts fixing it', async () => {
    // #46's rule: a message describes current state, not the state when the button was pressed.
    mockApi({ library: [] })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Add an exercise' }))
    await user.click(screen.getByRole('button', { name: 'Add exercise' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Name'), 'B')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('surfaces the server’s rejection instead of failing silently', async () => {
    mockApi({
      library: [],
      onPost: () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 'bad_request', message: 'name is required.' } }),
      }),
    })
    renderScreen()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Add an exercise' }))
    await user.type(screen.getByLabelText('Name'), 'Back Squat')
    await user.click(screen.getByRole('button', { name: 'Add exercise' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('name is required.')
    // Nothing the trainer typed is thrown away, because the point is that they can fix it.
    expect(screen.getByLabelText('Name')).toHaveValue('Back Squat')
  })

  it('offers a retry rather than an empty list when the library cannot be loaded', async () => {
    mockApi({ listFails: true })
    renderScreen()

    expect(await screen.findByText(/We couldn’t load your exercises/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    // An empty library and an unreachable one are different claims.
    expect(screen.queryByText(/No exercises yet/)).not.toBeInTheDocument()
  })

  it('makes the shell’s nav bar appear, now that there are two places to go', async () => {
    // TrainerShell hides the bar while NAV holds one item, on the grounds that a nav whose only
    // link is the page you are on is furniture. This ticket is the second destination, so the
    // bar renders for the first time — a shell behaviour with no test of its own until now.
    mockApi({ library: [] })
    renderScreen()

    const nav = await screen.findByRole('navigation', { name: 'Trainer' })
    expect(within(nav).getByRole('link', { name: 'Clients' })).toHaveAttribute('href', '/clients')

    const here = within(nav).getByRole('link', { name: 'Exercise library' })
    expect(here).toHaveAttribute('href', '/exercises')
    expect(here).toHaveAttribute('aria-current', 'page')
  })

  it('says the library is empty rather than showing a bare page', async () => {
    mockApi({ library: [] })
    renderScreen()

    expect(await screen.findByText(/No exercises yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add an exercise' })).toBeInTheDocument()
  })
})
