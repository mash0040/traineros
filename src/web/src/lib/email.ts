/**
 * Does this look enough like an email address to be worth sending?
 *
 * Deliberately weaker than the server's rule (#114, TrainerOS.Api/EmailAddresses.cs), and the
 * asymmetry is the design rather than an omission. The server is the authority: it decides
 * what gets stored, and its answer is surfaced verbatim when it says no. This exists only to
 * catch the typo the trainer can see and fix without a round trip.
 *
 * So it errs toward letting things through. A client-side rule stricter than the server's
 * would block an address the system would happily accept, with no override and no explanation
 * that means anything — the worst failure available to a validator. A rule looser than the
 * server's costs one round trip and a message.
 *
 * What it does catch is the whole family that made #114 a bug rather than a nuisance:
 * whitespace, angle brackets, commas, and quotes are the characters that turn a typed address
 * into RFC 5322 mailbox syntax, where the address a human reads and the address a mail server
 * extracts stop being the same string.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s<>,"@]+@[^\s<>,"@]+\.[^\s<>,"@]{2,}$/.test(value)
}
