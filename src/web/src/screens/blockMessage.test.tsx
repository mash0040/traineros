import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CONFIRMATION_MS, useBlockMessage } from './blockMessage'
import { Message } from './Message'

// DESIGN.md §Messages, "one slot per block" and "confirmations expire; questions do not".
//
// These are the invariants #141 turned from a convention into a structure, so they are worth
// pinning here rather than only at the sites that consume them: the defect was never a screen
// getting its own clear() wrong, it was that a screen could.
function Block() {
  const block = useBlockMessage('test-block')

  return (
    <div>
      {block.message !== null && (
        <Message id={block.id} tone={block.message.tone}>
          {block.message.body}
        </Message>
      )}

      <button onClick={() => block.ask('Delete it?')} type="button">
        ask
      </button>
      <button onClick={() => block.fail('It broke.')} type="button">
        fail
      </button>
      <button onClick={() => block.done('Saved.')} type="button">
        done
      </button>
      <button onClick={block.clear} type="button">
        clear
      </button>

      {/* The mechanism under test: the block's armed state is read off the slot, never off a
          second boolean beside it. */}
      {block.prompting && <p>armed</p>}
      <p data-testid="described-by">{block.describedBy ?? 'none'}</p>
    </div>
  )
}

describe('useBlockMessage', () => {
  describe('one slot', () => {
    it('replaces rather than stacks, whichever order the tones arrive in', async () => {
      const user = userEvent.setup()
      render(<Block />)

      await user.click(screen.getByRole('button', { name: 'ask' }))
      expect(screen.getAllByText(/Delete it\?|It broke\.|Saved\./)).toHaveLength(1)

      // The reported defect, in one line: a save that lands while a delete prompt is open.
      await user.click(screen.getByRole('button', { name: 'done' }))
      expect(screen.queryByText('Delete it?')).not.toBeInTheDocument()
      expect(screen.getByText('Saved.')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'fail' }))
      expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
      expect(screen.getByText('It broke.')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'ask' }))
      expect(screen.queryByText('It broke.')).not.toBeInTheDocument()
      expect(screen.getByText('Delete it?')).toBeInTheDocument()
    })

    it('disarms the block when anything replaces the question', async () => {
      const user = userEvent.setup()
      render(<Block />)

      await user.click(screen.getByRole('button', { name: 'ask' }))
      expect(screen.getByText('armed')).toBeInTheDocument()

      // The half that fixes the reported bug: the confirm/cancel controls come down with the
      // question, because they are the same piece of state.
      await user.click(screen.getByRole('button', { name: 'done' }))
      expect(screen.queryByText('armed')).not.toBeInTheDocument()
    })

    it('leaves the slot empty on a dismissal, with no receipt for the non-event', async () => {
      const user = userEvent.setup()
      render(<Block />)

      await user.click(screen.getByRole('button', { name: 'ask' }))
      await user.click(screen.getByRole('button', { name: 'clear' }))

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(screen.getByTestId('described-by')).toHaveTextContent('none')
    })

    it('points every control at one id, and at nothing when the slot is empty', async () => {
      const user = userEvent.setup()
      render(<Block />)

      expect(screen.getByTestId('described-by')).toHaveTextContent('none')

      await user.click(screen.getByRole('button', { name: 'fail' }))
      expect(screen.getByTestId('described-by')).toHaveTextContent('test-block')
      expect(screen.getByRole('alert')).toHaveAttribute('id', 'test-block')
    })

    it('announces a question like a failure and a receipt like a confirmation', async () => {
      const user = userEvent.setup()
      render(<Block />)

      // A prompt shares the failure treatment and its interrupting role: it is not a completed
      // write either. The split that matters to a screen reader is alert vs status.
      await user.click(screen.getByRole('button', { name: 'ask' }))
      expect(screen.getByRole('alert')).toHaveTextContent('Delete it?')

      await user.click(screen.getByRole('button', { name: 'done' }))
      expect(screen.getByRole('status')).toHaveTextContent('Saved.')
    })
  })

  describe('expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    function clickThrough(name: string) {
      act(() => {
        screen.getByRole('button', { name }).click()
      })
    }

    it('takes a confirmation down on its own, because a receipt has a short life', () => {
      render(<Block />)
      clickThrough('done')
      expect(screen.getByText('Saved.')).toBeInTheDocument()

      act(() => vi.advanceTimersByTime(CONFIRMATION_MS - 1))
      expect(screen.getByText('Saved.')).toBeInTheDocument()

      act(() => vi.advanceTimersByTime(1))
      expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
      // The wiring goes with it: an aria-describedby pointing at an element that no longer
      // exists is worse than none.
      expect(screen.getByTestId('described-by')).toHaveTextContent('none')
    })

    it('never expires a question, because a vanishing one cannot be told from a cancelled one', () => {
      render(<Block />)
      clickThrough('ask')

      act(() => vi.advanceTimersByTime(CONFIRMATION_MS * 5))

      expect(screen.getByText('Delete it?')).toBeInTheDocument()
      expect(screen.getByText('armed')).toBeInTheDocument()
    })

    it('never expires a failure, because it names something to retry', () => {
      render(<Block />)
      clickThrough('fail')

      act(() => vi.advanceTimersByTime(CONFIRMATION_MS * 5))

      expect(screen.getByText('It broke.')).toBeInTheDocument()
    })

    it('restarts the clock for a second confirmation rather than inheriting the first one’s', () => {
      render(<Block />)
      clickThrough('done')

      act(() => vi.advanceTimersByTime(CONFIRMATION_MS - 100))
      clickThrough('done')

      // Under an inherited timer this is where the second receipt would vanish, 100ms in.
      act(() => vi.advanceTimersByTime(200))
      expect(screen.getByText('Saved.')).toBeInTheDocument()

      act(() => vi.advanceTimersByTime(CONFIRMATION_MS))
      expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
    })

    it('does not resurrect a message the slot has moved on from', () => {
      render(<Block />)
      clickThrough('done')

      act(() => vi.advanceTimersByTime(CONFIRMATION_MS - 100))
      clickThrough('fail')

      // The confirmation's timer is still pending here. It must not clear the failure that
      // replaced it.
      act(() => vi.advanceTimersByTime(CONFIRMATION_MS))
      expect(screen.getByText('It broke.')).toBeInTheDocument()
    })
  })
})
