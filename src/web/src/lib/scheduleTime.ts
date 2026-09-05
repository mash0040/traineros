// The reminder schedule's time format, converted in the one direction that still needs it.
//
// This module used to convert both ways. #29 binds send_time to a C# TimeOnly and #51 recorded
// that an HH:mm string was a 400 from both schedule routes, so `toApiTime` appended `:00` to
// everything the form sent. #79 checked that premise and it no longer holds: the .NET 8 TimeOnly
// reader accepts HH:mm as readily as HH:mm:ss, so the padding was doing nothing. It is gone, and
// the API's own tests now pin the format so its absence is a decision rather than a drift.
//
// The render direction stays, and its reason was never the API. `<input type="time">` emits
// HH:mm because its default step is 60 seconds, and — the half that matters — it renders *empty*
// when handed a value it cannot parse. The API answers with seconds, so an existing schedule
// handed straight to the input would present as unset and turn a save into a blank-time
// rejection. That is the input element being strict, and nothing on the server changes it.

/** Short forms for the day checkboxes, where seven full names would not fit a row. */
export const DAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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
