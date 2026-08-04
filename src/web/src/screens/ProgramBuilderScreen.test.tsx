import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProgramDetailResponse } from '../api/types.gen'
import { ProgramBuilderScreen } from './ProgramBuilderScreen'

const program: ProgramDetailResponse = {
  id: 'program-1',
  clientId: 'client-ada',
  title: 'Winter Block',
  status: 'draft',
  startsOn: null,
  notes: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
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
          // Free text by design (database.md). A numeric input would refuse this value.
          targetReps: '8–10',
          targetLoad: '70 kg',
          restSeconds: 90,
          note: 'Brace before you unrack.',
          exercise: { id: 'ex-1', name: 'Back Squat', videoUrl: null, cues: null },
        },
      ],
    },
    { id: 'day-2', title: 'Upper', position: 2, prescriptions: [] },
  ],
}

describe('ProgramBuilderScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockApi(options: {
    tree?: ProgramDetailResponse
    treeStatus?: number
    onPost?: (url: string, body: unknown) => Partial<Response>
    onPatch?: (url: string, body: unknown) => Partial<Response>
    onDelete?: (url: string) => Partial<Response>
  }) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({}),
          ...options.onPost?.(url, JSON.parse(String(init.body))),
        })
      }
      if (init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
          ...options.onPatch?.(url, JSON.parse(String(init.body))),
        })
      }
      if (init?.method === 'DELETE') {
        return Promise.resolve({ ok: true, status: 204, json: async () => null, ...options.onDelete?.(url) })
      }

      const status = options.treeStatus ?? 200
      return Promise.resolve({
        ok: status === 200,
        status,
        json: async () =>
          status === 200 ? (options.tree ?? program) : { error: { code: 'not_found', message: 'Not Found' } },
      })
    })

    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function renderScreen() {
    return render(
      <MemoryRouter initialEntries={['/programs/program-1']}>
        <Routes>
          <Route path="/programs/:programId" element={<ProgramBuilderScreen />} />
          <Route path="/clients" element={<p>roster</p>} />
        </Routes>
      </MemoryRouter>,
    )
  }

  function callsOf(fetchMock: ReturnType<typeof mockApi>, method: string) {
    return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method)
  }

  function bodyOf(call: unknown[]): unknown {
    return JSON.parse(String((call[1] as RequestInit).body))
  }

  it('renders the tree: days, their prescriptions, and each prescription’s exercise', async () => {
    mockApi({})
    renderScreen()

    expect(await screen.findByRole('heading', { name: 'Winter Block', level: 1 })).toBeInTheDocument()
    expect(screen.getByDisplayValue('Lower')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Upper')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Back Squat', level: 3 })).toBeInTheDocument()
    expect(screen.getByText('Nothing prescribed on this day yet.')).toBeInTheDocument()
  })

  it('keeps reps and load as free text rather than numbers', async () => {
    // database.md's decision: "8–10", "AMRAP", "RPE 8" are real prescriptions. A number input
    // would reject every one of them, so this asserts the input type as well as the value —
    // the one case where the element's type is the behaviour rather than an implementation
    // detail.
    mockApi({})
    renderScreen()

    const reps = await screen.findByLabelText('Reps')
    expect(reps).toHaveValue('8–10')
    expect(reps).toHaveAttribute('type', 'text')

    const load = screen.getByLabelText('Load')
    expect(load).toHaveValue('70 kg')
    expect(load).toHaveAttribute('type', 'text')

    // Sets and rest genuinely are integers.
    expect(screen.getByLabelText('Sets')).toHaveAttribute('type', 'number')
    expect(screen.getByLabelText('Rest (seconds)')).toHaveAttribute('type', 'number')
  })

  it('saves a prescription with a non-numeric rep scheme intact', async () => {
    const fetchMock = mockApi({
      onPatch: (_url, body) => ({ json: async () => ({ id: 'presc-1', ...(body as object) }) }),
    })
    renderScreen()

    const reps = await screen.findByLabelText('Reps')
    await userEvent.clear(reps)
    await userEvent.type(reps, 'AMRAP')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('status')
    const patches = callsOf(fetchMock, 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0][0]).toBe('/api/day-exercises/presc-1')
    expect(bodyOf(patches[0])).toEqual({
      targetSets: 3,
      targetReps: 'AMRAP',
      targetLoad: '70 kg',
      restSeconds: 90,
      note: 'Brace before you unrack.',
    })
  })

  it('clears a nullable field by sending it blank', async () => {
    // #28's convention: blank string clears to NULL, absent leaves alone. Sending the whole
    // field set on every save is what makes clearing possible at all.
    const fetchMock = mockApi({
      onPatch: (_url, body) => ({ json: async () => ({ id: 'presc-1', ...(body as object) }) }),
    })
    renderScreen()

    await userEvent.clear(await screen.findByLabelText('Load'))
    await userEvent.clear(screen.getByLabelText('Rest (seconds)'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('status')
    expect(bodyOf(callsOf(fetchMock, 'PATCH')[0])).toMatchObject({ targetLoad: '', restSeconds: null })
  })

  it('adds a day and shows it without a reload', async () => {
    const fetchMock = mockApi({
      onPost: () => ({ json: async () => ({ id: 'day-3', programId: 'program-1', title: 'Conditioning', position: 3 }) }),
    })
    renderScreen()

    await userEvent.type(await screen.findByLabelText('Add a day'), 'Conditioning')
    await userEvent.click(screen.getByRole('button', { name: 'Add day' }))

    expect(await screen.findByDisplayValue('Conditioning')).toBeInTheDocument()
    const posts = callsOf(fetchMock, 'POST')
    expect(posts[0][0]).toBe('/api/programs/program-1/days')
    expect(bodyOf(posts[0])).toEqual({ title: 'Conditioning' })
    // A day created with no prescriptions renders like any other rather than crashing on an
    // absent array.
    const added = screen.getByDisplayValue('Conditioning').closest('li')!
    expect(within(added).getByText('Nothing prescribed on this day yet.')).toBeInTheDocument()
  })

  it('renames a day', async () => {
    const fetchMock = mockApi({
      onPatch: (_url, body) => ({ json: async () => ({ id: 'day-1', ...(body as object) }) }),
    })
    renderScreen()

    const title = await screen.findByDisplayValue('Lower')
    await userEvent.clear(title)
    await userEvent.type(title, 'Legs')
    await userEvent.click(within(title.closest('li')!).getByRole('button', { name: 'Save name' }))

    const patches = callsOf(fetchMock, 'PATCH')
    expect(patches[0][0]).toBe('/api/days/day-1')
    expect(bodyOf(patches[0])).toEqual({ title: 'Legs' })
  })

  it('promises the client’s history survives before deleting a day', async () => {
    // #17: the day's prescriptions cascade, but workout_sessions.program_day_id and
    // logged_sets.program_day_exercise_id are ON DELETE SET NULL. A trainer hesitating here is
    // usually worried about erasing what the client already did, and they cannot.
    const fetchMock = mockApi({})
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Delete Lower' }))

    expect(screen.getByText('Delete Lower? Its exercises go with it.')).toBeInTheDocument()
    expect(
      screen.getByText(/Workouts your client already logged stay in their history/),
    ).toBeInTheDocument()
    // Nothing written until the second press.
    expect(callsOf(fetchMock, 'DELETE')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Delete day' }))

    // Gone from the list without a reload, and the day beside it is untouched.
    await vi.waitFor(() => expect(screen.queryByDisplayValue('Lower')).not.toBeInTheDocument())
    expect(screen.getByDisplayValue('Upper')).toBeInTheDocument()
    expect(callsOf(fetchMock, 'DELETE')[0][0]).toBe('/api/days/day-1')
  })

  it('says logged sets survive before deleting a prescription', async () => {
    const fetchMock = mockApi({})
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    expect(
      screen.getByText(/Sets your client already logged against Back Squat stay in their history/),
    ).toBeInTheDocument()
    expect(callsOf(fetchMock, 'DELETE')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Delete Back Squat' }))

    // Scoped to the day it was removed from: the other day is empty too, so an unscoped
    // "Nothing prescribed" would match whether or not this one changed.
    const lower = screen.getByDisplayValue('Lower').closest('li')!
    await vi.waitFor(() =>
      expect(within(lower).getByText('Nothing prescribed on this day yet.')).toBeInTheDocument(),
    )
    expect(within(lower).queryByRole('heading', { name: 'Back Squat' })).not.toBeInTheDocument()
    expect(callsOf(fetchMock, 'DELETE')[0][0]).toBe('/api/day-exercises/presc-1')
  })

  it('surfaces the status transition and moves the program between them', async () => {
    const fetchMock = mockApi({
      onPatch: (_url, body) => ({ json: async () => ({ id: 'program-1', ...(body as object) }) }),
    })
    renderScreen()

    expect(await screen.findByRole('button', { name: 'Draft', pressed: true })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Active' }))

    const patches = callsOf(fetchMock, 'PATCH')
    expect(patches[0][0]).toBe('/api/programs/program-1')
    expect(bodyOf(patches[0])).toEqual({ status: 'active' })
    expect(await screen.findByRole('button', { name: 'Active', pressed: true })).toBeInTheDocument()
  })

  it('explains the 409 when the client already has an active program', async () => {
    // #27's one structural gate. The status code says there is a conflict; it does not say what
    // the trainer has to do about it, and that is the only actionable failure on this screen.
    mockApi({
      onPatch: () => ({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: 'program_active_conflict',
            message: 'This client already has an active program.',
          },
        }),
      }),
    })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Active' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This client already has an active program. Archive that one first, then activate this.',
    )
    // The program stayed where it was.
    expect(screen.getByRole('button', { name: 'Draft', pressed: true })).toBeInTheDocument()
  })

  it('takes the 409 down when the trainer clicks the status it is already in', async () => {
    // The reported bug, and the sharpest half of it: the "never mind" gesture is clicking the
    // status the program already has, and the no-op check used to return before the clear, so
    // the one action taken to dismiss the message was the one that could not.
    mockApi({
      onPatch: () => ({
        ok: false,
        status: 409,
        json: async () => ({
          error: { code: 'program_active_conflict', message: 'This client already has an active program.' },
        }),
      }),
    })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Active' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Draft' }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('takes the 409 down when a different transition succeeds', async () => {
    // Captured, the message outlived the attempt: it named a conflict about activating while
    // the program sat archived, until a reload.
    let reject = true
    mockApi({
      onPatch: (_url, body) =>
        reject
          ? {
              ok: false,
              status: 409,
              json: async () => ({
                error: { code: 'program_active_conflict', message: 'This client already has an active program.' },
              }),
            }
          : { json: async () => ({ id: 'program-1', ...(body as object) }) },
    })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Active' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    reject = false
    await userEvent.click(screen.getByRole('button', { name: 'Archived' }))

    expect(await screen.findByRole('button', { name: 'Archived', pressed: true })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('takes the 409 down when the retry it asked for succeeds', async () => {
    // The message tells the trainer to archive the other program and come back. When they do,
    // the thing that told them so has to be gone — it is derived from the program not being in
    // the status that was refused, so reaching that status removes it with no extra bookkeeping.
    let reject = true
    mockApi({
      onPatch: (_url, body) =>
        reject
          ? {
              ok: false,
              status: 409,
              json: async () => ({
                error: { code: 'program_active_conflict', message: 'This client already has an active program.' },
              }),
            }
          : { json: async () => ({ id: 'program-1', ...(body as object) }) },
    })
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Active' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    reject = false
    await userEvent.click(screen.getByRole('button', { name: 'Active' }))

    expect(await screen.findByRole('button', { name: 'Active', pressed: true })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears a day-name complaint as soon as a name is typed', async () => {
    // Same shape as the 409: the message described a blank field and stayed put while the
    // field stopped being blank.
    mockApi({})
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Add day' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A day needs a name.')

    await userEvent.type(screen.getByLabelText('Add a day'), 'C')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears a prescription complaint as soon as the field it names changes', async () => {
    mockApi({})
    renderScreen()

    const sets = await screen.findByLabelText('Sets')
    await userEvent.clear(sets)
    await userEvent.type(sets, '0')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sets must be a whole number above zero.')

    await userEvent.clear(sets)
    await userEvent.type(sets, '3')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('marks the exercise picker and reorder as not built yet, rather than half-building them', async () => {
    // #54 owns both. A disabled control that says what it is waiting for beats a screen that
    // silently offers no way to add an exercise.
    mockApi({})
    renderScreen()

    const add = await screen.findAllByRole('button', { name: 'Add exercise' })
    expect(add[0]).toBeDisabled()
    expect(
      screen.getAllByText(/Picking an exercise and reordering this list arrive with/)[0],
    ).toBeInTheDocument()
  })

  it('treats another trainer’s program id as not found', async () => {
    mockApi({ treeStatus: 404 })
    renderScreen()

    expect(await screen.findByRole('heading', { name: 'Program not found', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to clients' })).toHaveAttribute('href', '/clients')
  })

  it('separates an unreachable API from a missing program', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderScreen()

    expect(
      await screen.findByRole('heading', { name: 'We couldn’t load this program', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Program not found' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('refuses an empty day name without asking the server', async () => {
    const fetchMock = mockApi({})
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Add day' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A day needs a name.')
    expect(callsOf(fetchMock, 'POST')).toHaveLength(0)
  })

  it('refuses a non-positive set count without asking the server', async () => {
    const fetchMock = mockApi({})
    renderScreen()

    const sets = await screen.findByLabelText('Sets')
    await userEvent.clear(sets)
    await userEvent.type(sets, '0')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Sets must be a whole number above zero.')
    expect(callsOf(fetchMock, 'PATCH')).toHaveLength(0)
  })
})
