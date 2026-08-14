import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Message } from './Message'

// DESIGN.md §Messages requires three axes of difference, and the reason it requires three is
// that colour alone fails for a red-green colourblind reader and in a greyscale screenshot.
//
// Per .claude/rules/conventions.md, a purely visual property has no behavioural proxy in jsdom
// and asserting classes tests implementation. These tests are deliberately limited to the axes
// that are *not* purely visual: the ARIA role and the presence of a distinguishing glyph. The
// tint and the weight are the human's to check in a browser. What is pinned here is that a
// refactor cannot quietly reduce the treatment back to colour-only.
describe('Message', () => {
  it('interrupts for a failure and waits its turn for a confirmation', () => {
    render(<Message tone="failure">It broke.</Message>)
    expect(screen.getByRole('alert')).toHaveTextContent('It broke.')

    render(<Message tone="confirmation">Saved.</Message>)
    expect(screen.getByRole('status')).toHaveTextContent('Saved.')
  })

  it('distinguishes the two tones by something other than colour', () => {
    const failure = render(<Message tone="failure">It broke.</Message>)
    const confirmation = render(<Message tone="confirmation">Saved.</Message>)

    const glyphOf = (result: ReturnType<typeof render>) =>
      result.container.querySelector('[aria-hidden="true"]')?.textContent

    expect(glyphOf(failure)).toBe('!')
    expect(glyphOf(confirmation)).toBe('✓')
    expect(glyphOf(failure)).not.toBe(glyphOf(confirmation))
  })

  it('hides the glyph from screen readers, since the role already says which it is', () => {
    // Otherwise every error in the product is read out as "exclamation mark" first.
    render(<Message tone="failure">It broke.</Message>)
    expect(screen.getByRole('alert')).toHaveAccessibleName('')
    expect(screen.getByRole('alert').textContent).toBe('!It broke.')
  })

  it('accepts an id so a field can point its aria-describedby at the message', () => {
    render(
      <Message id="add-client-error" tone="failure">
        Enter their name.
      </Message>,
    )
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'add-client-error')
  })

  // The confirmation prompts are a question plus what the act does and does not touch, which is
  // why the panel is a div. A <p> silently reparents block children out of itself, and the
  // second half of a destructive prompt is the half that stops a trainer hesitating.
  it('holds a multi-block prompt without the browser splitting it', () => {
    const { container } = render(
      <Message tone="failure">
        <p>Retire Back Squat?</p>
        <p>Programs already using it keep it.</p>
      </Message>,
    )

    const panel = screen.getByRole('alert')
    expect(container.querySelectorAll('p')).toHaveLength(2)
    expect(panel).toContainElement(container.querySelectorAll('p')[1])
  })
})
