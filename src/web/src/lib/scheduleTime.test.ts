// @vitest-environment node
//
// Pure functions, no DOM. Building a jsdom environment for these costs ~5s per file and
// buys nothing; the DOM-touching suites are the ones that need it.

import { describe, expect, it } from 'vitest'

import { describeDays, toInputTime } from './scheduleTime'

// #29's TimeOnly binds HH:mm:ss and rejects HH:mm with a 400, while `<input type="time">`
// emits HH:mm. These are the tests that keep the seam honest in both directions — a miss on
// either one is a schedule editor that looks fine and cannot save.
describe('toInputTime', () => {
  it('strips the seconds the input cannot parse', () => {
    // An input handed "07:30:00" renders empty, which shows an existing schedule as unset and
    // turns the next save into a blank-time rejection.
    expect(toInputTime('07:30:00')).toBe('07:30')
  })

  it('handles a value that already fits, and a missing one', () => {
    expect(toInputTime('07:30')).toBe('07:30')
    expect(toInputTime(null)).toBe('')
    expect(toInputTime(undefined)).toBe('')
    expect(toInputTime('nonsense')).toBe('')
  })

  it('round-trips what the form sends against what the API answers', () => {
    // #79 removed toApiTime, so the form now sends the input's own value. The API stores it and
    // answers with seconds, and this is what puts it back in the input unchanged.
    expect(toInputTime('06:15:00')).toBe('06:15')
  })
})

describe('describeDays', () => {
  it('reads the schedule back as a sentence', () => {
    expect(describeDays([1, 3, 5])).toBe('Mon, Wed and Fri')
    expect(describeDays([2])).toBe('Tue')
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day')
  })

  it('sorts by day number, not by the order they were clicked', () => {
    // #29 normalizes days_of_week to sorted-and-deduplicated on the way in, so a summary in
    // click order would disagree with what a reload shows.
    expect(describeDays([5, 1, 3])).toBe('Mon, Wed and Fri')
    expect(describeDays([3, 3, 1])).toBe('Mon and Wed')
  })

  it('says so when nothing is picked', () => {
    expect(describeDays([])).toBe('No days')
  })
})
