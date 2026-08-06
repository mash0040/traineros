// @vitest-environment node
//
// Pure functions, no DOM. Building a jsdom environment for these costs ~5s per file and
// buys nothing; the DOM-touching suites are the ones that need it.

import { describe, expect, it } from 'vitest'

import type { HistoryItem } from '../api/types.gen'
import { exerciseOptions, formatSessionDate, groupSessions } from './history'

// The feed as the endpoint hands it back: flat sets, newest first, session summary and
// exercise on every row.
function set(
  overrides: {
    id: string
    session: string
    performedOn: string
    exercise: string
    exerciseName?: string
    setNumber: number
    weightKg?: number | null
    reps?: number
    comment?: string | null
    programDayId?: string | null
  },
): HistoryItem {
  return {
    id: overrides.id,
    setNumber: overrides.setNumber,
    weightKg: overrides.weightKg === undefined ? 100 : overrides.weightKg,
    reps: overrides.reps ?? 5,
    loggedAt: `2026-08-01T10:00:00Z`,
    session: {
      id: overrides.session,
      performedOn: overrides.performedOn,
      comment: overrides.comment ?? null,
      programDayId: overrides.programDayId ?? null,
    },
    exercise: { id: overrides.exercise, name: overrides.exerciseName ?? 'Back Squat' },
  }
}

describe('groupSessions', () => {
  it('groups a flat set feed into reverse-chron sessions, each read in the order worked', () => {
    // Newest first, and within a session the newest set first: the last thing she did on
    // Friday was her second set of bench.
    const items = [
      set({ id: 's4', session: 'fri', performedOn: '2026-07-31', exercise: 'bench', exerciseName: 'Bench Press', setNumber: 2 }),
      set({ id: 's3', session: 'fri', performedOn: '2026-07-31', exercise: 'bench', exerciseName: 'Bench Press', setNumber: 1 }),
      set({ id: 's2', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', setNumber: 2 }),
      set({ id: 's1', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', setNumber: 1 }),
      set({ id: 's0', session: 'wed', performedOn: '2026-07-29', exercise: 'squat', setNumber: 1 }),
    ]

    const sessions = groupSessions(items, { hasMore: false })

    expect(sessions.map((session) => session.id)).toEqual(['fri', 'wed'])
    expect(sessions[0].setCount).toBe(4)
    // Squat came first in the workout even though bench came first in the feed.
    expect(sessions[0].exercises.map((exercise) => exercise.name)).toEqual([
      'Back Squat',
      'Bench Press',
    ])
    expect(sessions[0].exercises[0].sets.map((s) => s.setNumber)).toEqual([1, 2])
  })

  it('merges a session split across two pages into one, rather than two half-workouts', () => {
    // The boundary case the whole module exists for: pagination counts sets, the screen renders
    // sessions, so page 1 can end mid-workout. Grouping runs over everything loaded so far,
    // keyed by session id, so page 2 lands in the group page 1 opened.
    const pageOne = [
      set({ id: 's3', session: 'fri', performedOn: '2026-07-31', exercise: 'bench', exerciseName: 'Bench Press', setNumber: 1 }),
      set({ id: 's2', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', setNumber: 2 }),
    ]
    const pageTwo = [
      set({ id: 's1', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', setNumber: 1 }),
      set({ id: 's0', session: 'wed', performedOn: '2026-07-29', exercise: 'squat', setNumber: 1 }),
    ]

    const sessions = groupSessions([...pageOne, ...pageTwo], { hasMore: false })

    expect(sessions.map((session) => session.id)).toEqual(['fri', 'wed'])
    expect(sessions[0].setCount).toBe(3)
    expect(sessions[0].exercises.map((exercise) => exercise.name)).toEqual([
      'Back Squat',
      'Bench Press',
    ])
    expect(sessions[0].exercises[0].sets.map((s) => s.setNumber)).toEqual([1, 2])
  })

  it('withholds the session the page cut in half rather than reporting a short count', () => {
    // Friday is complete; Wednesday owns the oldest loaded set and may have more past the
    // cursor. Showing "1 set" for a workout that was twelve is a wrong number, not a partial
    // render, so it waits for the page that finishes it.
    const items = [
      set({ id: 's2', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', setNumber: 1 }),
      set({ id: 's1', session: 'wed', performedOn: '2026-07-29', exercise: 'squat', setNumber: 3 }),
    ]

    expect(groupSessions(items, { hasMore: true }).map((session) => session.id)).toEqual(['fri'])
    // Nothing is withheld once the feed is exhausted: there is no page left to complete it.
    expect(groupSessions(items, { hasMore: false }).map((session) => session.id)).toEqual([
      'fri',
      'wed',
    ])
  })

  it('carries the session summary through, including the note and the program day', () => {
    const items = [
      set({
        id: 's1',
        session: 'fri',
        performedOn: '2026-07-31',
        exercise: 'squat',
        setNumber: 1,
        comment: 'Shoulder tweaked on OHP.',
        programDayId: 'day-1',
      }),
    ]

    const [session] = groupSessions(items, { hasMore: false })
    expect(session.comment).toBe('Shoulder tweaked on OHP.')
    expect(session.programDayId).toBe('day-1')
    expect(session.performedOn).toBe('2026-07-31')
  })

  it('keeps a bodyweight set, which has no weight at all', () => {
    const items = [
      set({ id: 's1', session: 'fri', performedOn: '2026-07-31', exercise: 'chin', setNumber: 1, weightKg: null, reps: 8 }),
    ]

    const [session] = groupSessions(items, { hasMore: false })
    expect(session.exercises[0].sets[0]).toMatchObject({ weightKg: null, reps: 8 })
  })
})

describe('exerciseOptions', () => {
  it('lists each exercise in the feed once, alphabetically', () => {
    const items = [
      set({ id: 's3', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', setNumber: 2 }),
      set({ id: 's2', session: 'fri', performedOn: '2026-07-31', exercise: 'squat', setNumber: 1 }),
      set({ id: 's1', session: 'wed', performedOn: '2026-07-29', exercise: 'bench', exerciseName: 'Bench Press', setNumber: 1 }),
    ]

    // By name, not by the order they appear in the feed: the control is a list to find your
    // exercise in, and its order should not change every time you train.
    expect(exerciseOptions(items)).toEqual([
      { id: 'squat', name: 'Back Squat' },
      { id: 'bench', name: 'Bench Press' },
    ])
  })
})

describe('formatSessionDate', () => {
  it('reads performed_on as a calendar date, not an instant', () => {
    // The suite runs in UTC (vite.config.ts), so this asserts the format. The reason the
    // function rebuilds the date at UTC midnight is the other half: handing '2026-07-31' to
    // new Date() and rendering it in a browser west of Greenwich moves the workout to the 30th.
    expect(formatSessionDate('2026-07-31')).toBe('Fri, 31 Jul 2026')
  })

  it('shows the raw value rather than "Invalid Date" if the shape ever changes', () => {
    expect(formatSessionDate('')).toBe('')
  })
})
