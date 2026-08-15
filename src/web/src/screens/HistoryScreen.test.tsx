import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HistoryItem, HistoryResponse, MeResponse } from '../api/types.gen'
import { HistoryScreen } from './HistoryScreen'

function set(overrides: {
  id: string
  session: string
  performedOn: string
  exercise: string
  exerciseName: string
  setNumber: number
  weightKg?: number | null
  reps?: number
  comment?: string | null
}): HistoryItem {
  return {
    id: overrides.id,
    setNumber: overrides.setNumber,
    weightKg: overrides.weightKg === undefined ? 100 : overrides.weightKg,
    reps: overrides.reps ?? 5,
    loggedAt: '2026-07-31T10:00:00Z',
    session: {
      id: overrides.session,
      performedOn: overrides.performedOn,
      comment: overrides.comment ?? null,
      programDayId: 'day-1',
    },
    exercise: { id: overrides.exercise, name: overrides.exerciseName },
  }
}

// Newest first, as the endpoint returns it, and every set of a session carries that session's
// summary — including the note, which is a column on the session and not on the set.
const friday = [
  set({ id: 's4', session: 'fri', performedOn: '2026-07-31', exercise: 'bench', exerciseName: 'Bench Press', setNumber: 2, weightKg: 60, reps: 8, comment: 'Felt heavy.' }),
  set({ id: 's3', session: 'fri', performedOn: '2026-07-31', exercise: 'bench', exerciseName: 'Bench Press', setNumber: 1, weightKg: 60, reps: 10, comment: 'Felt heavy.' }),
  set({ id: 's2', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', exerciseName: 'Back Squat', setNumber: 2, weightKg: 102.5, reps: 5, comment: 'Felt heavy.' }),
  set({ id: 's1', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', exerciseName: 'Back Squat', setNumber: 1, weightKg: 100, reps: 5, comment: 'Felt heavy.' }),
]

const saturday = [
  set({ id: 'x1', session: 'sat', performedOn: '2026-08-01', exercise: 'row', exerciseName: 'Barbell Row', setNumber: 1, weightKg: 70, reps: 10 }),
]

const wednesday = [
  set({ id: 'w2', session: 'wed', performedOn: '2026-07-29', exercise: 'squat', exerciseName: 'Back Squat', setNumber: 2, weightKg: 95, reps: 5 }),
  set({ id: 'w1', session: 'wed', performedOn: '2026-07-29', exercise: 'squat', exerciseName: 'Back Squat', setNumber: 1, weightKg: 95, reps: 5 }),
]

describe('HistoryScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Answers each history request from a handler keyed on the URL it was asked with. */
  function stubHistory(handler: (url: string) => HistoryResponse) {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => handler(url),
    }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  // kg, for the same reason the log screen's fixture is (#99): every assertion here was written
  // about canonical kilograms. The lb path has its own test at the bottom.
  const me: MeResponse = {
    id: 'client-1',
    displayName: 'Ada',
    email: 'ada@example.com',
    timezone: 'America/Toronto',
    weightUnit: 'kg',
  }

  function renderScreen(who: MeResponse = me) {
    return render(
      <MemoryRouter>
        <HistoryScreen me={who} />
      </MemoryRouter>,
    )
  }

  function urls(fetchMock: ReturnType<typeof stubHistory>): string[] {
    return fetchMock.mock.calls.map((call) => String(call[0]))
  }

  it('draws a skeleton first, then the sessions newest first', async () => {
    // ui-ux.md asks for a skeleton on History. It is a status, not a spinner over the content.
    let resolve: (value: HistoryResponse) => void = () => {}
    const pending = new Promise<HistoryResponse>((keep) => {
      resolve = keep
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => pending })),
    )

    renderScreen()

    expect(await screen.findByRole('status')).toHaveTextContent('Loading your history')

    resolve({ items: [...friday, ...wednesday], nextCursor: null })

    const cards = await screen.findAllByRole('button', { expanded: false })
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual([
      'Fri, 31 Jul 2026, 2 exercises, 4 sets',
      'Wed, 29 Jul 2026, 1 exercise, 2 sets',
    ])
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('opens a session to its per-exercise sets, and closes it again', async () => {
    stubHistory(() => ({ items: [...friday, ...wednesday], nextCursor: null }))
    renderScreen()

    const card = await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ })
    // Collapsed, the card is a summary: no sets on screen yet.
    expect(screen.queryByRole('heading', { name: 'Back Squat' })).not.toBeInTheDocument()

    await userEvent.click(card)

    expect(card).toHaveAttribute('aria-expanded', 'true')
    const session = card.closest('li')!
    // Exercises read in the order she worked them, not the order the newest-first feed
    // returned them.
    expect(
      within(session)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Back Squat', 'Bench Press'])
    // Each row is announced as one set rather than as two adjacent numbers, which is what
    // "1" beside "100 × 5" reads as when the grid is the only thing separating them.
    // Scoped by the set list's own accessible name rather than by walking up to `closest('div')`
    // — the markup around the heading is not the test's business, and it changed once already.
    const squat = within(session).getByRole('list', { name: 'Back Squat' })
    expect(within(squat).getAllByRole('listitem').map((row) => row.getAttribute('aria-label'))).toEqual([
      'Set 1, 100 kilograms by 5 reps',
      'Set 2, 102.5 kilograms by 5 reps',
    ])
    expect(within(session).getByText('Felt heavy.')).toBeInTheDocument()

    await userEvent.click(card)

    expect(card).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('heading', { name: 'Back Squat' })).not.toBeInTheDocument()
  })

  it('pages with the cursor api.md specifies, never an offset', async () => {
    const fetchMock = stubHistory((url) =>
      url.includes('before=')
        ? { items: wednesday, nextCursor: null }
        : { items: friday, nextCursor: '2026-07-31T10:00:00Z' },
    )
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Load older workouts' }))

    expect(await screen.findByRole('button', { name: /Wed, 29 Jul 2026/ })).toBeInTheDocument()
    expect(urls(fetchMock)[1]).toContain('before=2026-07-31T10%3A00%3A00Z')
    expect(urls(fetchMock).join(' ')).not.toMatch(/offset|page=/)
    // Exhausted: the control goes away rather than fetching an empty page forever.
    expect(screen.queryByRole('button', { name: 'Load older workouts' })).not.toBeInTheDocument()
  })

  it('holds back a session the page boundary cut, then shows it whole', async () => {
    // The decision this screen turns on. Page 1 ends mid-Friday, so Friday's card would read
    // "1 exercise, 1 set" for a four-set workout. It waits for the page that completes it and
    // then appears once, with everything.
    const fetchMock = stubHistory((url) =>
      url.includes('before=')
        ? { items: [...friday.slice(1), ...wednesday], nextCursor: null }
        : { items: [...saturday, friday[0]], nextCursor: '2026-07-31T10:00:00Z' },
    )
    renderScreen()

    // Saturday is complete and shows. Friday is half-loaded and does not.
    expect(await screen.findByRole('button', { name: /Sat, 1 Aug 2026/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Fri, 31 Jul 2026/ })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Load older workouts' }))

    // One card, not two, and with the count the whole workout actually had.
    const friCards = await screen.findAllByRole('button', { name: /Fri, 31 Jul 2026/ })
    expect(friCards).toHaveLength(1)
    expect(friCards[0]).toHaveAccessibleName('Fri, 31 Jul 2026, 2 exercises, 4 sets')
    expect(urls(fetchMock)).toHaveLength(2)
  })

  it('keeps reading when one workout fills an entire page, rather than showing an empty screen', async () => {
    // Withholding the cut session can leave nothing to render. A "Load more" button above an
    // empty list reads as "you have never trained", so the screen fetches on rather than
    // showing it.
    const fetchMock = stubHistory((url) =>
      url.includes('before=')
        ? { items: [...friday.slice(1), ...wednesday], nextCursor: null }
        : { items: [friday[0]], nextCursor: '2026-07-31T10:00:00Z' },
    )
    renderScreen()

    expect(await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ })).toHaveAccessibleName(
      'Fri, 31 Jul 2026, 2 exercises, 4 sets',
    )
    expect(screen.queryByRole('heading', { name: 'Nothing logged yet' })).not.toBeInTheDocument()
    expect(urls(fetchMock)).toHaveLength(2)
  })

  it('filters at the server, so it reaches past the pages already on screen', async () => {
    // The point of the filter is "every time I have squatted", which is a question about all of
    // history and not about the two pages loaded. So it re-queries with exercise_id and starts
    // the cursor over rather than filtering the array in hand.
    const fetchMock = stubHistory((url) =>
      url.includes('exercise_id=squat')
        ? { items: [...friday.slice(2), ...wednesday], nextCursor: null }
        : { items: [...friday, ...wednesday], nextCursor: null },
    )
    renderScreen()

    await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ })
    await userEvent.selectOptions(screen.getByLabelText('Exercise'), 'squat')

    expect(urls(fetchMock)[1]).toContain('exercise_id=squat')
    expect(urls(fetchMock)[1]).not.toContain('before=')
    expect(
      (await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ })).getAttribute('aria-label'),
    ).toBe('Fri, 31 Jul 2026, 1 exercise, 2 sets')
  })

  it('keeps every exercise in the filter after filtering to one of them', async () => {
    // The filtered response only mentions squats. If the options came from what is loaded, the
    // control would collapse to the one option already chosen and there would be no way back.
    stubHistory((url) =>
      url.includes('exercise_id=squat')
        ? { items: [...friday.slice(2), ...wednesday], nextCursor: null }
        : { items: [...friday, ...wednesday], nextCursor: null },
    )
    renderScreen()

    await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ })
    await userEvent.selectOptions(screen.getByLabelText('Exercise'), 'squat')
    await screen.findByRole('button', { name: 'Fri, 31 Jul 2026, 1 exercise, 2 sets' })

    expect(
      within(screen.getByLabelText('Exercise'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All exercises', 'Back Squat', 'Bench Press'])

    await userEvent.selectOptions(screen.getByLabelText('Exercise'), '')
    expect(
      await screen.findByRole('button', { name: 'Fri, 31 Jul 2026, 2 exercises, 4 sets' }),
    ).toBeInTheDocument()
  })

  it('names the exercise when a filter turns up nothing', async () => {
    stubHistory((url) =>
      url.includes('exercise_id=bench')
        ? { items: [], nextCursor: null }
        : { items: [...friday, ...wednesday], nextCursor: null },
    )
    renderScreen()

    await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ })
    await userEvent.selectOptions(screen.getByLabelText('Exercise'), 'bench')

    expect(
      await screen.findByRole('heading', { name: 'No sets for Bench Press yet', level: 2 }),
    ).toBeInTheDocument()
  })

  it('treats no history at all as an empty state, not an error', async () => {
    stubHistory(() => ({ items: [], nextCursor: null }))
    renderScreen()

    expect(
      await screen.findByRole('heading', { name: 'Nothing logged yet', level: 2 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    // Nothing to filter by yet, so no control that can only do nothing.
    expect(screen.queryByLabelText('Exercise')).not.toBeInTheDocument()
  })

  it('offers a retry when history cannot be loaded', async () => {
    // Same distinction Today draws: a dropped request is not an empty log.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: friday, nextCursor: null }) })
    vi.stubGlobal('fetch', fetchMock)
    renderScreen()

    expect(
      await screen.findByRole('heading', { name: 'We couldn’t load your history', level: 2 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Nothing logged yet' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ })).toBeInTheDocument()
  })

  it('keeps the loaded workouts on screen when a later page fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [...saturday, ...friday], nextCursor: '2026-07-31T10:00:00Z' }),
      })
      .mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: 'Load older workouts' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t load any more. Check your connection.',
    )
    // The workouts she was reading are still there.
    expect(screen.getByRole('button', { name: /Sat, 1 Aug 2026/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('shows a bodyweight set as reps, with no weight invented for it', async () => {
    stubHistory(() => ({
      items: [
        set({ id: 'c1', session: 'fri', performedOn: '2026-07-31', exercise: 'chin', exerciseName: 'Chin-up', setNumber: 1, weightKg: null, reps: 8 }),
      ],
      nextCursor: null,
    }))
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ }))

    expect(screen.getByRole('listitem', { name: 'Set 1, 8 reps' })).toBeInTheDocument()
    expect(screen.getByText('8 reps')).toBeInTheDocument()
  })

  // ── Weight unit (#99) ─────────────────────────────────────────────────────────────────────

  it('reads history in the client’s unit, from the same canonical kilograms', async () => {
    // The stored row is identical either way — that is the point of one unit in the database.
    // 83.91458845 kg is exactly 185 lb, so nothing is lost in the reading.
    stubHistory(() => ({
      items: [
        set({ id: 's1', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', exerciseName: 'Back Squat', setNumber: 1, weightKg: 83.91458845, reps: 5 }),
      ],
      nextCursor: null,
    }))
    renderScreen({ ...me, weightUnit: 'lb' })

    await userEvent.click(await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ }))

    // The spoken form spells the unit out; the visible form is the bare number beside a ×.
    expect(screen.getByRole('listitem', { name: 'Set 1, 185 pounds by 5 reps' })).toBeInTheDocument()
  })

  it('says kilograms for a client who reads in kilograms', async () => {
    stubHistory(() => ({
      items: [
        set({ id: 's1', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', exerciseName: 'Back Squat', setNumber: 1, weightKg: 102.5, reps: 5 }),
      ],
      nextCursor: null,
    }))
    renderScreen()

    await userEvent.click(await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ }))

    expect(
      screen.getByRole('listitem', { name: 'Set 1, 102.5 kilograms by 5 reps' }),
    ).toBeInTheDocument()
  })

  it('names the unit once per exercise, so a bare number is never left unexplained', async () => {
    // The reported bug: "22.05 × 3" with nothing saying what 22.05 is — and it is exactly the
    // number that needs saying, because it is what the client converted from.
    stubHistory(() => ({
      items: [
        set({ id: 's1', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', exerciseName: 'Back Squat', setNumber: 1, weightKg: 10, reps: 3 }),
        set({ id: 's2', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', exerciseName: 'Back Squat', setNumber: 2, weightKg: 10, reps: 3 }),
      ],
      nextCursor: null,
    }))
    renderScreen({ ...me, weightUnit: 'lb' })

    await userEvent.click(await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ }))

    // "lbs", not "lb" — the display label, not the stored enum.
    expect(screen.getByText('lbs')).toBeInTheDocument()
    // Once for the group, not once per row: two sets, one label. Same rule DESIGN.md §Log row
    // applies to the log screen's column header.
    expect(screen.getAllByText('lbs')).toHaveLength(1)
  })

  it('leaves the unit off a group with nothing but bodyweight sets', async () => {
    // A unit over a column of "8 reps" would be a unit for a number that is not there.
    stubHistory(() => ({
      items: [
        set({ id: 'c1', session: 'fri', performedOn: '2026-07-31', exercise: 'chin', exerciseName: 'Chin-up', setNumber: 1, weightKg: null, reps: 8 }),
      ],
      nextCursor: null,
    }))
    renderScreen({ ...me, weightUnit: 'lb' })

    await userEvent.click(await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ }))

    expect(screen.queryByText('lbs')).not.toBeInTheDocument()
  })

  it('leaves a bodyweight set alone in either unit', async () => {
    // weight_kg NULL has no unit to convert, and inventing a zero would be a claim.
    stubHistory(() => ({
      items: [
        set({ id: 'c1', session: 'fri', performedOn: '2026-07-31', exercise: 'chin', exerciseName: 'Chin-up', setNumber: 1, weightKg: null, reps: 8 }),
      ],
      nextCursor: null,
    }))
    renderScreen({ ...me, weightUnit: 'lb' })

    await userEvent.click(await screen.findByRole('button', { name: /Fri, 31 Jul 2026/ }))

    expect(screen.getByRole('listitem', { name: 'Set 1, 8 reps' })).toBeInTheDocument()
  })
})
