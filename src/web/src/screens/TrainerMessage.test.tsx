import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TrainerMessage } from './TrainerMessage'

// DESIGN.md §Messages requires three axes of difference, and the reason it requires three is
// that colour alone fails for a red-green colourblind trainer and in a greyscale screenshot.
//
// Per .claude/rules/conventions.md, a purely visual property has no behavioural proxy in jsdom
// and asserting classes tests implementation. These tests are deliberately limited to the axes
// that are *not* purely visual: the ARIA role and the presence of a distinguishing glyph. The
// tint and the weight are the human's to check in a browser. What is pinned here is that a
// refactor cannot quietly reduce the treatment back to colour-only.
describe('TrainerMessage', () => {
  it('interrupts for a failure and waits its turn for a confirmation', () => {
    render(<TrainerMessage tone="failure">It broke.</TrainerMessage>)
    expect(screen.getByRole('alert')).toHaveTextContent('It broke.')

    render(<TrainerMessage tone="confirmation">Saved.</TrainerMessage>)
    expect(screen.getByRole('status')).toHaveTextContent('Saved.')
  })

  it('distinguishes the two tones by something other than colour', () => {
    const failure = render(<TrainerMessage tone="failure">It broke.</TrainerMessage>)
    const confirmation = render(<TrainerMessage tone="confirmation">Saved.</TrainerMessage>)

    const glyphOf = (result: ReturnType<typeof render>) =>
      result.container.querySelector('[aria-hidden="true"]')?.textContent

    expect(glyphOf(failure)).toBe('!')
    expect(glyphOf(confirmation)).toBe('✓')
    expect(glyphOf(failure)).not.toBe(glyphOf(confirmation))
  })

  it('hides the glyph from screen readers, since the role already says which it is', () => {
    // Otherwise every error in the product is read out as "exclamation mark" first.
    render(<TrainerMessage tone="failure">It broke.</TrainerMessage>)
    expect(screen.getByRole('alert')).toHaveAccessibleName('')
    expect(screen.getByRole('alert').textContent).toBe('!It broke.')
  })

  it('accepts an id so a field can point its aria-describedby at the message', () => {
    render(
      <TrainerMessage id="add-client-error" tone="failure">
        Enter their name.
      </TrainerMessage>,
    )
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'add-client-error')
  })
})
