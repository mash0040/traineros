// @vitest-environment node
//
// Pure functions, no DOM. Building a jsdom environment for these costs ~5s per file and
// buys nothing; the DOM-touching suites are the ones that need it.

import { describe, expect, it } from 'vitest'

import { ApiError } from './api'
import { messageFor } from './apiMessages'

describe('messageFor', () => {
  it('says what the SPA knows and the API cannot, for a stale picker', () => {
    // The case DESIGN.md §Messages names as the reason this map exists at all. The server sees
    // an id it will not accept; only the SPA knows it drew the list that offered it.
    const message = messageFor(
      new ApiError(400, 'unknown_exercise', 'Unknown exercise_id.'),
      'prescription',
    )

    expect(message).toBe(
      'That exercise was retired, so it cannot be added. Reload to see the current library.',
    )
    expect(message).not.toContain('exercise_id')
  })

  it('reads the same 404 differently depending on what was being written', () => {
    // The server answers a bare "Not Found" for a program, a day and an exercise alike. "That
    // is gone" is only useful if it names what, which is the entire reason context is a
    // required argument rather than an optional one.
    const notFound = new ApiError(404, 'not_found', 'Not Found')

    expect(messageFor(notFound, 'program')).toContain('This program no longer exists')
    expect(messageFor(notFound, 'day')).toContain('This day has already been deleted')
    expect(messageFor(notFound, 'exercise')).toContain('no longer in your library')
    expect(messageFor(notFound, 'schedule')).toContain('reminder schedule no longer exists')
  })

  it('never lets the bare HTTP reason phrase reach a trainer', () => {
    // Every context is mapped, but the unmapped-context safety net matters more than the
    // mapped ones: "Not Found" is the string a new context would otherwise inherit by default.
    for (const context of ['client', 'schedule', 'program', 'day', 'prescription', 'exercise'] as const) {
      expect(messageFor(new ApiError(404, 'not_found', 'Not Found'), context)).not.toBe('Not Found')
    }
  })

  it('falls back to the server’s message for codes it has nothing to add to', () => {
    // Not a gap. bad_request covers ~27 distinct validation failures under one code, and the
    // server is the only layer that knows which field it rejected. A blanket rewrite would say
    // strictly less than the string it replaced.
    expect(
      messageFor(new ApiError(400, 'bad_request', 'Please enter a valid email address.'), 'client'),
    ).toBe('Please enter a valid email address.')
  })

  it('falls back for an unrecognised code rather than swallowing it', () => {
    // A code added by a future API ticket must surface something, not vanish into a generic.
    expect(messageFor(new ApiError(409, 'some_future_code', 'A specific explanation.'), 'program')).toBe(
      'A specific explanation.',
    )
  })

  it('does not render an empty panel when the server sends no message', () => {
    // A message-shaped hole says a write failed without saying anything, which is worse than
    // the generic sentence.
    expect(messageFor(new ApiError(500, 'weird', '   '), 'program')).toBe(
      'Something went wrong. Try again.',
    )
  })

  it('gives a generic sentence for anything that is not an ApiError', () => {
    // A bug in the SPA must never render a stack-trace fragment into a form.
    expect(messageFor(new TypeError('x.y is not a function'), 'client')).toBe(
      'Something went wrong. Try again.',
    )
    expect(messageFor('a string', 'client')).toBe('Something went wrong. Try again.')
  })

  it('carries the instruction the API has no business knowing, for a conflict', () => {
    // Previously built by concatenating onto the server's sentence at the call site, so the
    // trainer read one sentence written for them joined to one written for a developer.
    expect(
      messageFor(
        new ApiError(409, 'program_active_conflict', 'This client already has an active program.'),
        'program',
      ),
    ).toBe('This client already has an active program. Archive that one first, then activate this.')
  })

  it('answers a dropped connection without blaming the trainer’s input', () => {
    // Thrown by the fetch layer, so there is no server message underneath it to fall back to.
    expect(messageFor(new ApiError(0, 'network', 'Something went wrong. Try again.'), 'day')).toBe(
      'We could not reach the server. Check your connection and try again.',
    )
  })

  it('keeps every mapped sentence free of em dashes and of snake_case field names', () => {
    // DESIGN.md §Absolute bans applies to copy in a map exactly as it does to copy in a
    // component, and the whole point of the exercise is that no field name reaches a trainer.
    const codes = [
      'not_found',
      'unknown_exercise',
      'unknown_program_day',
      'unknown_program_day_exercise',
      'unknown_client',
      'program_active_conflict',
      'schedule_exists',
      'email_taken',
      'network',
      'rate_limited',
      'internal_error',
      'unauthorized',
      'invalid_token',
    ]
    const contexts = ['client', 'schedule', 'program', 'day', 'prescription', 'exercise'] as const

    for (const code of codes) {
      for (const context of contexts) {
        const message = messageFor(new ApiError(400, code, 'SERVER FALLBACK'), context)
        // Skips the fallback: this asserts about mapped copy, and reaching the server string
        // for one of these would be caught by the assertions above.
        if (message === 'SERVER FALLBACK') {
          continue
        }
        expect(message, `${context}:${code}`).not.toMatch(/—|--/)
        expect(message, `${context}:${code}`).not.toMatch(/[a-z]_[a-z]/)
      }
    }
  })
})
