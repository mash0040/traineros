import { describe, expect, it } from 'vitest'

import { describeDays, toApiTime, toInputTime } from './scheduleTime'

// #29's TimeOnly binds HH:mm:ss and rejects HH:mm with a 400, while `<input type="time">`
// emits HH:mm. These are the tests that keep the seam honest in both directions — a miss on
// either one is a schedule editor that looks fine and cannot save.
describe('toApiTime', () => {
  it('appends the seconds the API requires', () => {
    expect(toApiTime('07:30')).toBe('07:30:00')
    expect(toApiTime('00:00')).toBe('00:00:00')
    expect(toApiTime('23:59')).toBe('23:59:00')
  })

  it('leaves an already-seconded value alone', () => {
    // A browser with a sub-minute step emits HH:mm:ss. Appending again would send
    // "07:30:00:00", which is a 400 with a confusing message attached.
    expect(toApiTime('07:30:45')).toBe('07:30:45')
  })

  it('passes anything unrecognised through for the server to reject', () => {
    // Not this function's job to invent a time. Guessing here would turn a form bug into a
    // silently wrong reminder hour.
    expect(toApiTime('')).toBe('')
    expect(toApiTime('half seven')).toBe('half seven')
  })
})

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

  it('round-trips with toApiTime', () => {
    expect(toInputTime(toApiTime('06:15'))).toBe('06:15')
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
