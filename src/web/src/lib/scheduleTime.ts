// The one place the reminder schedule's time format is converted, because two systems disagree
// about it and neither is going to change.
//
// #29 binds send_time to a C# TimeOnly, which serializes and parses as HH:mm:ss. An HH:mm
// string is a 400 from POST /api/clients/:id/schedule and PATCH /api/schedules/:id.
//
// `<input type="time">` emits HH:mm, because its default step is 60 seconds. It only produces
// HH:mm:ss when a sub-minute step is set, which this form has no reason to do — reminder times
// are picked to the minute.
//
// So every read from the input needs seconds appended and every write into it needs them
// removed, and doing that inline at the call site is how one of the two directions eventually
// gets missed.

/** Sunday-first, matching #29's 0..6 day numbering. Index is the wire value. */
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Short forms for the day checkboxes, where seven full names would not fit a row. */
export const DAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * `<input type="time">` value to what the API will accept: "07:30" becomes "07:30:00".
 *
 * Already-seconded input is passed through rather than re-appended, so a browser that does
 * emit HH:mm:ss (any that sets a sub-minute step) does not produce "07:30:00:00".
 */
export function toApiTime(inputValue: string): string {
  const trimmed = inputValue.trim()
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    return trimmed
  }

  return trimmed.length === 5 ? `${trimmed}:00` : trimmed
}

/**
 * The API's "07:30:00" back to the "07:30" the input expects.
 *
 * An input handed a value it cannot parse renders empty, which would silently present an
 * existing schedule as unset and turn a save into a blank-time rejection.
 */
export function toInputTime(apiValue: string | null | undefined): string {
  if (apiValue == null) {
    return ''
  }

  const match = /^(\d{2}:\d{2})(:\d{2})?/.exec(apiValue.trim())
  return match === null ? '' : match[1]
}

/**
 * "Mon, Wed and Fri" — the schedule read back as a sentence.
 *
 * Sorted by day number rather than by selection order, matching how #29 normalizes and stores
 * them, so the summary agrees with what a reload shows.
 */
export function describeDays(days: number[]): string {
  const named = [...new Set(days)]
    .filter((day) => day >= 0 && day <= 6)
    .sort((left, right) => left - right)
    .map((day) => DAY_ABBREVIATIONS[day])

  if (named.length === 0) {
    return 'No days'
  }
  if (named.length === 7) {
    return 'Every day'
  }
  if (named.length === 1) {
    return named[0]
  }

  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
}
