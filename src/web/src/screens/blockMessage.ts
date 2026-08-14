import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

// DESIGN.md §Messages, "one slot per block". The state machine behind the rule, in one place so
// no screen re-derives it.
//
// ── The defect this exists to make unrepresentable (#141) ──────────────────────────────────
// A prescription row held `confirming` (is the delete prompt open) and `saved` (did the last
// save land) as two independent booleans. Nothing connected them, so answering neither question
// left both true: the trainer opened the delete prompt, changed their mind and pressed Save
// instead, and the row rendered "Saved." stacked on top of a delete prompt still asking whether
// to remove the exercise they had just saved. Two messages, one of them describing a decision
// the trainer had already walked away from.
//
// That is #46's defect in a new dress. #46 fixed it on the log screen by deriving the discard
// prompt from current state rather than capturing it when Finish was tapped, and the lesson
// never crossed to the trainer screens: every block over there kept two, three, or four
// independent message flags and relied on each write handler to remember to clear the others.
// ClientRow cleared two of three. Day cleared none of the rename form's from the delete
// cluster's. The bug was not that someone forgot a `setSaved(false)`; it was that forgetting one
// was possible at all.
//
// ── The fix is structural, not another clear() call ────────────────────────────────────────
// One state, holding one message. A prompt is not a flag beside the message — the prompt *is*
// the message, and whether the block is armed is read back off it (`prompting`). So a
// confirmation and an open prompt cannot coexist, because writing one is what removes the
// other. There is no ordering for a handler to get wrong and no second flag to forget.
//
// This is the same move as deriving, applied to a slot rather than to a value: the block always
// shows the most recent thing that happened in it, and nothing can outlive the thing after it.
//
// ── Where a block should *not* use this ────────────────────────────────────────────────────
// When the message depends on state the block does not own. The log screen's Finish footer is
// the case: its prompt has to disappear when she saves the unsaved row, and that row lives in a
// different block entirely, so the footer computes its one message instead of storing it. One
// slot is the rule; storing it is the common implementation, not the rule itself.

/**
 * `prompt` and `failure` share DESIGN.md's failure treatment and are distinct here because they
 * behave differently: a prompt arms the block's controls and never expires, a failure does
 * neither. See Message.tsx for why they look alike.
 */
export type BlockTone = 'failure' | 'prompt' | 'confirmation'

/**
 * How long a confirmation stays before it takes itself down.
 *
 * A confirmation is a receipt, and DESIGN.md §Messages records why it expires while the other
 * two tones do not. Six seconds is read off the copy: the longest confirmation in the product
 * ("Ada is deactivated. Their reminder emails have stopped.") is about nine words, which is
 * ~3s of reading, and the other ~3s is the glance back — a trainer presses Save while looking
 * at the button, not at the slot above it.
 *
 * Not shorter, because 3s is gone before someone who looked away has looked back. Not longer,
 * because at ten seconds a receipt is still on screen while the trainer is filling in the next
 * thing, which is the state that made these panels feel like clutter rather than answers.
 */
export const CONFIRMATION_MS = 6000

export type BlockMessage = { tone: BlockTone; body: ReactNode }

export type Block = {
  /** The one DOM id this block's message carries, whichever tone is in the slot. */
  id: string
  message: BlockMessage | null
  /** Whether an unanswered question is in the slot. Gates the block's confirm/cancel controls. */
  prompting: boolean
  /** For the block's controls: points at the message when there is one, nothing when there isn't. */
  describedBy: string | undefined
  /** Ask a question. Arms the block. Replaces whatever was in the slot. */
  ask: (body: ReactNode) => void
  /** Report a refusal. Disarms the block, because the question is no longer the live one. */
  fail: (body: ReactNode) => void
  /** Report a write that landed. Expires on its own after CONFIRMATION_MS. */
  done: (body: ReactNode) => void
  /** Empty the slot. What Cancel does, and what editing a field does. */
  clear: () => void
}

/**
 * One block's message slot.
 *
 * `id` is the slot's, not the message's: only one message can be in it, so every control in the
 * block points its `aria-describedby` at the same place regardless of what is showing. That
 * replaced a three-way ternary over three separate ids at every call site, which was its own
 * small source of drift — two of them pointed at an id that no longer rendered.
 */
export function useBlockMessage(id: string): Block {
  const [message, setMessage] = useState<BlockMessage | null>(null)

  // Only confirmations expire. A failure is actionable and a prompt is a question — a question
  // that vanishes on its own leaves the trainer unsure whether it was cancelled, which is worse
  // than the clutter expiry is meant to solve.
  //
  // Keyed on the message object rather than on its tone, so a second confirmation restarts the
  // clock instead of inheriting the remains of the first one's.
  useEffect(() => {
    if (message === null || message.tone !== 'confirmation') {
      return
    }

    const timer = setTimeout(() => {
      // Guarded as well as cleaned up: cleanup covers the ordinary replacement, and this covers
      // the case where a timer fires against a slot that has already moved on.
      setMessage((current) => (current === message ? null : current))
    }, CONFIRMATION_MS)

    return () => clearTimeout(timer)
  }, [message])

  const ask = useCallback((body: ReactNode) => setMessage({ tone: 'prompt', body }), [])
  const fail = useCallback((body: ReactNode) => setMessage({ tone: 'failure', body }), [])
  const done = useCallback((body: ReactNode) => setMessage({ tone: 'confirmation', body }), [])
  const clear = useCallback(() => setMessage(null), [])

  return useMemo(
    () => ({
      id,
      message,
      prompting: message?.tone === 'prompt',
      describedBy: message === null ? undefined : id,
      ask,
      fail,
      done,
      clear,
    }),
    [id, message, ask, fail, done, clear],
  )
}
