// @vitest-environment node
//
// Pure functions, no DOM. Building a jsdom environment for these costs ~5s per file and
// buys nothing; the DOM-touching suites are the ones that need it.

import { describe, expect, it } from 'vitest'

import { looksLikeEmail } from './email'

// The mirror of TrainerOS.Api/EmailAddresses.cs, and deliberately the weaker half of the pair
// (#114). These tests pin both halves of that: what it must catch, and what it must NOT
// reject — because a client-side rule stricter than the server's locks a real client out of
// the product with a message they cannot argue with.
describe('looksLikeEmail', () => {
  it.each([
    'ada@example.com',
    'ada.lovelace@example.com',
    'ada+tag@example.co.uk',
    'ada@sub.example.com',
    // Unicode domains are real. The server accepts them, so this must too.
    'ada@münchen.de',
  ])('accepts %s', (candidate) => {
    expect(looksLikeEmail(candidate)).toBe(true)
  })

  it.each([
    // The family that made #114 a bug: characters that turn a typed address into RFC 5322
    // mailbox syntax, where the address a human reads is not the one a mail server extracts.
    'Ada <ada@example.com>',
    '<ada@example.com>',
    'ada example@example.com',
    'ada@example.com, bob@example.com',
    '"Ada" <ada@example.com>',
    // Ordinary typos.
    'plainaddress',
    'ada@',
    '@example.com',
    'ada@@example.com',
    'ada@localhost',
    'ada@b',
    '',
  ])('rejects %s', (candidate) => {
    expect(looksLikeEmail(candidate)).toBe(false)
  })

  it.each([
    // Accepted here and refused by the server. That direction is the design: the round trip
    // costs one request and the trainer gets the server's own message. The reverse — this
    // rejecting something the server would take — is the failure mode with no way out.
    'ada@example..com',
    'ada@exam_ple.com',
    'ada..b@example.com',
  ])('leaves %s for the server to refuse', (candidate) => {
    expect(looksLikeEmail(candidate)).toBe(true)
  })
})
