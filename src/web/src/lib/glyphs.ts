// Glyphs that appear in rendered strings and are governed by DESIGN.md rather than chosen per
// screen. There is exactly one of them in v1, and it earns a module because #138 found two
// screens answering the same question two different ways.

/**
 * "There is no value here", wherever a value would otherwise be.
 *
 * An en dash, not an em dash. DESIGN.md §Absolute bans rules em dashes out of every rendered
 * string, and the logging screen was rendering `—` for a bodyweight set while the roster
 * rendered `–` for a client whose last session had not loaded — one meaning, two glyphs, one of
 * them banned.
 *
 * Not the empty string, and not "None". An empty cell in a column of numbers reads as a
 * rendering failure, and a word in that column reads as data. A dash is the typographic
 * convention for a cell that has nothing in it, and at `tabular-nums` it sits on the same
 * advance as the digits it stands in for.
 *
 * Callers that render this in a column a screen reader walks should pair it with visually
 * hidden text saying what is not known — the glyph alone announces as "dash" or as nothing at
 * all, depending on the reader. ClientsScreen's LastSession is the worked example.
 */
export const NO_VALUE = '–'
