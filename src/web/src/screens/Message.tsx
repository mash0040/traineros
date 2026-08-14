// DESIGN.md §Messages, in one component so no screen can drift back into what the #53/#54
// desktop passes found: every outcome rendered as text-sm at weight 400 in one of two colours,
// in the same slot, distinguishable only by reading it.
//
// ── Why this is `Message` and not `TrainerMessage` ─────────────────────────────────────────
// It was trainer-only, on DESIGN.md's old scope split: client screens are single-purpose, so
// their few messages were said to be the whole content of the view and to need no panel to
// differentiate them from anything. That reasoning does not survive contact with the screens.
// A client's login error, a rejected verify, a failed set save and a dropped page of history
// all render *beside* other content, and a message with no panel among body text is the defect
// #138 named on the trainer side — colour alone, at 14px, in a paragraph the eye has no reason
// to stop on. The roster's own confirmation prompts were the worst case and they were on the
// screen the split said was covered.
//
// So the treatment is app-wide now, and the component's name says so. See DESIGN.md §Messages.
//
// ── Three axes, all required ───────────────────────────────────────────────────────────────
// Tint, weight, and glyph. Colour is deliberately the one carrying least: amber (hue 65) and
// red (hue 25) are ~40° apart and are the textbook deuteranopia confusion pair, so a 7–10%
// tint of one against the other is close to no signal for a red-green colourblind reader, and
// none at all in a greyscale screenshot. The glyph and the weight survive both.
//
// Which is why this is a component rather than two strings in trainerControls.ts: the glyph is
// part of the treatment, and a className cannot carry a child. A screen that reached for a
// class would get the tint and silently drop the two axes that do the work.
//
// ── Not for loading text ───────────────────────────────────────────────────────────────────
// "Loading your clients" is not an outcome. It stays plain muted body text with role="status"
// and no panel, because a panel means something happened.

/**
 * `failure` and `prompt` are one treatment and two behaviours, which is why they are two names.
 *
 * The treatment is shared because both are "this is not a completed write": something was
 * refused, or something is about to be taken away and is waiting on an answer. A prompt armed in
 * --danger matches the control that arms it, which is already trainerDanger.
 *
 * The behaviours differ, and blockMessage.ts is where that lives: a prompt arms the block's
 * controls and never expires, a failure does neither, and a confirmation expires on its own.
 * Collapsing the two names here would have made "is this block armed" unanswerable from the
 * slot, which is the whole mechanism by which #141 stopped a prompt and a confirmation from
 * being on screen together.
 */
type Tone = 'failure' | 'prompt' | 'confirmation'

const PANEL = 'flex items-start gap-2 rounded-sm border px-3 py-2 text-sm'

const FAILURE = {
  glyph: '!',
  glyphTone: 'text-danger',
  panel: 'border-danger-edge bg-danger-surface',
  text: 'font-semibold text-ink-bold',
}

const TONES: Record<Tone, { glyph: string; panel: string; text: string; glyphTone: string }> = {
  // Weight 600 on the failure and 400 on the confirmation, per DESIGN.md: a failure has to
  // interrupt, a confirmation has to be available without interrupting, since the person
  // already knows they pressed Save. Bolding both would flatten them again the other way.
  failure: FAILURE,
  prompt: FAILURE,
  confirmation: {
    glyph: '✓',
    glyphTone: 'text-ink',
    panel: 'border-accent-edge bg-accent-surface',
    text: 'text-ink',
  },
}

export function Message({
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
    // A div rather than the <p> this used to be. The confirmation prompts are two blocks — the
    // question, then what the act does and does not touch — and a <p> cannot hold them. Nothing
    // was gained by the paragraph element either: the role below is what announces this, and a
    // one-line message reads identically in a div.
    <div
      className={`${PANEL} ${style.panel} ${style.text} ${className ?? ''}`}
      id={id}
      // A failure or an unanswered question interrupts whatever a screen reader is saying; a
      // confirmation waits its turn. The same split the visual treatment makes, in the channel
      // that cannot see it.
      role={tone === 'confirmation' ? 'status' : 'alert'}
    >
      {/* aria-hidden because the role already announces what kind of message this is, and a
          screen reader reading "exclamation mark" before every error is noise. The glyph is
          for the eye; the role is for the ear. */}
      <span aria-hidden="true" className={`font-semibold ${style.glyphTone}`}>
        {style.glyph}
      </span>
      {/* min-w-0 and wrap-break-word together, because either alone leaves the 390px case
          broken. Messages quote trainer-supplied text — an email address in "ada@… added", an
          exercise name in "Retire …?" — and a flex item's default minimum is min-content, which
          for an unbroken address is the whole address. min-w-0 lets the panel shrink; the break
          is what stops the shrinking from turning into overflow. Same pair the roster already
          applies to the email column it renders. */}
      <div className="grid min-w-0 gap-2 wrap-break-word">{children}</div>
    </div>
  )
}
