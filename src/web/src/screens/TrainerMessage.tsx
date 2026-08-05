// DESIGN.md §Messages, in one component so the trainer screens cannot drift back into what the
// #53/#54 desktop passes found: every outcome rendered as text-sm at weight 400 in one of two
// colours, in the same slot, distinguishable only by reading it.
//
// ── Three axes, all required ───────────────────────────────────────────────────────────────
// Tint, weight, and glyph. Colour is deliberately the one carrying least: amber (hue 65) and
// red (hue 25) are ~40° apart and are the textbook deuteranopia confusion pair, so a 7–10%
// tint of one against the other is close to no signal for a red-green colourblind trainer, and
// none at all in a greyscale screenshot. The glyph and the weight survive both.
//
// Which is why this is a component rather than two strings in trainerControls.ts: the glyph is
// part of the treatment, and a className cannot carry a child. A screen that reached for a
// class would get the tint and silently drop the two axes that do the work.
//
// ── Not for loading text ───────────────────────────────────────────────────────────────────
// "Loading your clients" is not an outcome. It stays plain muted body text with role="status"
// and no panel, because a panel means something happened.

type Tone = 'failure' | 'confirmation'

const PANEL = 'flex items-start gap-2 rounded-sm border px-3 py-2 text-sm'

const TONES: Record<Tone, { glyph: string; panel: string; text: string; glyphTone: string }> = {
  // Weight 600 on the failure and 400 on the confirmation, per DESIGN.md: a failure has to
  // interrupt, a confirmation has to be available without interrupting, since the trainer
  // already knows they pressed Save. Bolding both would flatten them again the other way.
  failure: {
    glyph: '!',
    glyphTone: 'text-danger',
    panel: 'border-danger-edge bg-danger-surface',
    text: 'font-semibold text-ink-bold',
  },
  confirmation: {
    glyph: '✓',
    glyphTone: 'text-ink',
    panel: 'border-accent-edge bg-accent-surface',
    text: 'text-ink',
  },
}

export function TrainerMessage({
  children,
  className,
  id,
  tone,
}: {
  children: React.ReactNode
  className?: string
  id?: string
  tone: Tone
}) {
  const style = TONES[tone]

  return (
    <p
      className={`${PANEL} ${style.panel} ${style.text} ${className ?? ''}`}
      id={id}
      // A failure interrupts whatever a screen reader is saying; a confirmation waits its turn.
      // The same split the visual treatment makes, in the channel that cannot see it.
      role={tone === 'failure' ? 'alert' : 'status'}
    >
      {/* aria-hidden because the role already announces what kind of message this is, and a
          screen reader reading "exclamation mark" before every error is noise. The glyph is
          for the eye; the role is for the ear. */}
      <span aria-hidden="true" className={`font-semibold ${style.glyphTone}`}>
        {style.glyph}
      </span>
      <span>{children}</span>
    </p>
  )
}
