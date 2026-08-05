import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExerciseResponse, ProgramDetailResponse } from '../api/types.gen'
import { ProgramBuilderScreen } from './ProgramBuilderScreen'

// #26 soft-deletes, so GET /api/exercises returns retired rows alongside live ones. The picker
// has to tell them apart on its own.
const library: ExerciseResponse[] = [
  { id: 'ex-1', name: 'Back Squat', videoUrl: null, cues: null, isActive: true, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'ex-2', name: 'Bench Press', videoUrl: null, cues: null, isActive: true, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'ex-3', name: 'Sissy Squat', videoUrl: null, cues: null, isActive: false, createdAt: '2026-01-01T00:00:00Z' },
]

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
    library?: ExerciseResponse[]
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

      if (url === '/api/exercises') {
        return Promise.resolve({ ok: true, status: 200, json: async () => options.library ?? library })
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

  /**
   * One prescription's editor, scoped by the exercise it names.
   *
   * Needed since #54: every day now carries an add form with its own Exercise/Sets/Reps
   * labels, so an unscoped getByLabelText('Reps') matches both the row being edited and the
   * form for adding the next one.
   */
  function prescriptionRow(name: string) {
    return screen.getByRole('heading', { level: 3, name }).closest('li')!
  }

  /** One day's card, scoped by its name field. */
  function dayCard(title: string) {
    return screen.getByDisplayValue(title).closest('li')!
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

    await screen.findByDisplayValue('Lower')
    const row = within(prescriptionRow('Back Squat'))

    const reps = row.getByLabelText('Reps')
    expect(reps).toHaveValue('8–10')
    expect(reps).toHaveAttribute('type', 'text')

    const load = row.getByLabelText('Load')
    expect(load).toHaveValue('70 kg')
    expect(load).toHaveAttribute('type', 'text')

    // Sets and rest genuinely are integers.
    expect(row.getByLabelText('Sets')).toHaveAttribute('type', 'number')
    expect(row.getByLabelText('Rest (seconds)')).toHaveAttribute('type', 'number')
  })

  it('saves a prescription with a non-numeric rep scheme intact', async () => {
    const fetchMock = mockApi({
      onPatch: (_url, body) => ({ json: async () => ({ id: 'presc-1', ...(body as object) }) }),
    })
    renderScreen()

    await screen.findByDisplayValue('Lower')
    const row = within(prescriptionRow('Back Squat'))

    const reps = row.getByLabelText('Reps')
    await userEvent.clear(reps)
    await userEvent.type(reps, 'AMRAP')
    await userEvent.click(row.getByRole('button', { name: 'Save' }))

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

    await screen.findByDisplayValue('Lower')
    const row = within(prescriptionRow('Back Squat'))

    await userEvent.clear(row.getByLabelText('Load'))
    await userEvent.clear(row.getByLabelText('Rest (seconds)'))
    await userEvent.click(row.getByRole('button', { name: 'Save' }))

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

    await screen.findByDisplayValue('Lower')
    const row = within(prescriptionRow('Back Squat'))

    const sets = row.getByLabelText('Sets')
    await userEvent.clear(sets)
    await userEvent.type(sets, '0')
    await userEvent.click(row.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sets must be a whole number above zero.')

    await userEvent.clear(sets)
    await userEvent.type(sets, '3')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // -- The picker (#54) --

  it('offers the library’s active exercises and hides the retired ones', async () => {
    // #26 soft-deletes and the library route returns retired rows so the library screen can
    // bring one back. But #28 refuses a retired exercise on a new prescription with 400
    // unknown_exercise, so offering one would be offering a choice the server has already
    // decided against.
    mockApi({})
    renderScreen()

    await screen.findByDisplayValue('Lower')
    const picker = within(dayCard('Lower')).getByLabelText('Exercise')
    const options = within(picker).getAllByRole('option').map((option) => option.textContent)

    expect(options).toEqual(['Choose one', 'Back Squat', 'Bench Press'])
    expect(options).not.toContain('Sissy Squat')
  })

  it('adds an exercise to a day and shows the row without a reload', async () => {
    const fetchMock = mockApi({
      onPost: () => ({
        json: async () => ({
          id: 'presc-new',
          programDayId: 'day-2',
          exerciseId: 'ex-2',
          position: 1,
          targetSets: 4,
          targetReps: '5',
          targetLoad: null,
          restSeconds: null,
          note: null,
        }),
      }),
    })
    renderScreen()

    // The empty day, so the new row is unambiguous.
    const upper = (await screen.findByDisplayValue('Upper')).closest('li')!
    await userEvent.selectOptions(within(upper).getByLabelText('Exercise'), 'ex-2')
    const sets = within(upper).getByLabelText('Sets')
    await userEvent.clear(sets)
    await userEvent.type(sets, '4')
    await userEvent.type(within(upper).getByLabelText('Reps'), '5')
    await userEvent.click(within(upper).getByRole('button', { name: 'Add exercise' }))

    // The create response carries exercise_id but not the exercise, so the name is filled in
    // from the library rather than left blank until a reload.
    expect(await within(upper).findByRole('heading', { name: 'Bench Press', level: 3 })).toBeInTheDocument()

    const posts = callsOf(fetchMock, 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0][0]).toBe('/api/days/day-2/exercises')
    expect(bodyOf(posts[0])).toEqual({ exerciseId: 'ex-2', targetSets: 4, targetReps: '5' })
  })

  it('refuses to add without an exercise chosen, and without asking the server', async () => {
    const fetchMock = mockApi({})
    renderScreen()

    const upper = (await screen.findByDisplayValue('Upper')).closest('li')!
    await userEvent.type(within(upper).getByLabelText('Reps'), '5')
    await userEvent.click(within(upper).getByRole('button', { name: 'Add exercise' }))

    expect(await within(upper).findByRole('alert')).toHaveTextContent('Pick an exercise.')
    expect(callsOf(fetchMock, 'POST')).toHaveLength(0)
  })

  it('sends the trainer to the library when there is nothing to pick', async () => {
    // Nothing to prescribe, so the picker is replaced by the way out of the situation. Since
    // #55 that is a real route rather than a sentence describing one.
    mockApi({ library: [] })
    renderScreen()

    expect(await screen.findAllByText(/Your exercise library is empty/)).not.toHaveLength(0)
    expect(screen.queryByLabelText('Exercise')).not.toBeInTheDocument()

    const links = screen.getAllByRole('link', { name: 'Add an exercise' })
    expect(links).not.toHaveLength(0)
    expect(links[0]).toHaveAttribute('href', '/exercises')
  })

  it('surfaces a rejection for an exercise retired since the screen loaded', async () => {
    // The picker only offers active exercises, but the trainer may have retired one in another
    // tab. #28 answers 400 unknown_exercise, and this is the canonical case for SPA-owned copy:
    // the server cannot know a stale picker offered the id, so it can only say the id is
    // unknown. The SPA drew that list, so it is the layer that can say the library moved on.
    mockApi({
      onPost: () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 'unknown_exercise', message: 'Unknown exercise_id.' } }),
      }),
    })
    renderScreen()

    const upper = (await screen.findByDisplayValue('Upper')).closest('li')!
    await userEvent.selectOptions(within(upper).getByLabelText('Exercise'), 'ex-1')
    await userEvent.type(within(upper).getByLabelText('Reps'), '5')
    await userEvent.click(within(upper).getByRole('button', { name: 'Add exercise' }))

    expect(await within(upper).findByRole('alert')).toHaveTextContent(
      'That exercise was retired, so it cannot be added. Reload to see the current library.',
    )
  })

  // -- Reorder (#54) --

  /** A day with three prescriptions, so a middle row has somewhere to go in both directions. */
  const threeUp: ProgramDetailResponse = {
    ...program,
    days: [
      {
        id: 'day-1',
        title: 'Lower',
        position: 1,
        prescriptions: [
          { id: 'p1', position: 1, targetSets: 3, targetReps: '5', targetLoad: null, restSeconds: null, note: null, exercise: { id: 'ex-1', name: 'Back Squat', videoUrl: null, cues: null } },
          { id: 'p2', position: 2, targetSets: 3, targetReps: '8', targetLoad: null, restSeconds: null, note: null, exercise: { id: 'ex-2', name: 'Bench Press', videoUrl: null, cues: null } },
          { id: 'p3', position: 3, targetSets: 3, targetReps: '10', targetLoad: null, restSeconds: null, note: null, exercise: { id: 'ex-4', name: 'Row', videoUrl: null, cues: null } },
        ],
      },
    ],
  }

  function exerciseOrder() {
    return screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
  }

  it('sends the day’s complete ordered list to move one row', async () => {
    // The invariant #28 is built on: it rewrites positions 1..N in one transaction and rejects
    // anything partial, so "move up" is the whole order restated rather than a request about
    // one row. Sending only the pair that swapped would be a 400.
    const fetchMock = mockApi({ tree: threeUp })
    renderScreen()

    expect(await screen.findByDisplayValue('Lower')).toBeInTheDocument()
    expect(exerciseOrder()).toEqual(['Back Squat', 'Bench Press', 'Row'])

    await userEvent.click(screen.getByRole('button', { name: 'Move Row up' }))

    const patches = callsOf(fetchMock, 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0][0]).toBe('/api/days/day-1/order')
    expect(bodyOf(patches[0])).toEqual({ orderedIds: ['p1', 'p3', 'p2'] })
    await vi.waitFor(() => expect(exerciseOrder()).toEqual(['Back Squat', 'Row', 'Bench Press']))
  })

  it('moves a row down with the same full-list request', async () => {
    const fetchMock = mockApi({ tree: threeUp })
    renderScreen()

    expect(await screen.findByDisplayValue('Lower')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Move Back Squat down' }))

    expect(bodyOf(callsOf(fetchMock, 'PATCH')[0])).toEqual({ orderedIds: ['p2', 'p1', 'p3'] })
    await vi.waitFor(() => expect(exerciseOrder()).toEqual(['Bench Press', 'Back Squat', 'Row']))
  })

  it('does not offer a move off either end of the list', async () => {
    mockApi({ tree: threeUp })
    renderScreen()

    expect(await screen.findByDisplayValue('Lower')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move Back Squat up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move Row down' })).toBeDisabled()
    // And the ones with somewhere to go are live.
    expect(screen.getByRole('button', { name: 'Move Back Squat down' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Move Row up' })).toBeEnabled()
  })

  it('leaves the order alone when the reorder is rejected', async () => {
    // Sent before the list moves, so there is no optimistic state to roll back. A reorder that
    // appears to work and silently did not is the failure worth avoiding on a screen whose
    // output another person trains from.
    mockApi({
      tree: threeUp,
      onPatch: (url) =>
        url.endsWith('/order')
          ? {
              ok: false,
              status: 400,
              json: async () => ({
                error: { code: 'bad_request', message: 'ordered_ids must be exactly the day’s prescriptions.' },
              }),
            }
          : { json: async () => ({}) },
    })
    renderScreen()

    expect(await screen.findByDisplayValue('Lower')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Move Row up' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('ordered_ids must be exactly')
    expect(exerciseOrder()).toEqual(['Back Squat', 'Bench Press', 'Row'])
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

    await screen.findByDisplayValue('Lower')
    const row = within(prescriptionRow('Back Squat'))

    const sets = row.getByLabelText('Sets')
    await userEvent.clear(sets)
    await userEvent.type(sets, '0')
    await userEvent.click(row.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Sets must be a whole number above zero.')
    expect(callsOf(fetchMock, 'PATCH')).toHaveLength(0)
  })
})
