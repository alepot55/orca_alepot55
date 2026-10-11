import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import {
  isPaneReplaying,
  replayIntoTerminal,
  waitForTerminalReplayWritesParsed,
  type ReplayingPanesRef
} from '@/components/terminal-pane/replay-guard'
import { waitForTerminalOutputParsed } from './pane-terminal-output-scheduler'
import {
  _resetWritePipelineHealthForTests,
  armTerminalWriteStallWatch,
  captureTerminalParseProgressGeneration,
  hasTerminalParseProgressSince,
  isTerminalWritePipelineCertifiedDead,
  registerUndeliverableWriteHandler
} from './terminal-write-pipeline-health'

// Pins the xterm contract the parse barriers rely on: resize() drains the write queue
// synchronously, and that drain must neither lose a barrier's callback nor the output behind it.

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function makeTerminal(): Terminal {
  return new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
}

function firstRows(terminal: Terminal): string[] {
  return [0, 1].map((row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '')
}

/** Real xterm that gets trailing output and a resize right after its first zero-byte write is queued. */
function makeTerminalResizedBehindFirstBarrier(
  terminal: Terminal,
  options: { dropCompletions?: boolean } = {}
): {
  rows: number
  write: (data: string | Uint8Array, callback?: () => void) => void
} {
  let resizedBehindBarrier = false
  return {
    rows: terminal.rows,
    write(data, callback) {
      const isBarrier = data.length === 0
      terminal.write(data, options.dropCompletions && !isBarrier ? undefined : callback)
      if (isBarrier && !resizedBehindBarrier) {
        resizedBehindBarrier = true
        terminal.write('after\r\n')
        terminal.resize(40, 10)
      }
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('parse barriers across a terminal resize', () => {
  it('settles the output wait and keeps the output queued behind it', async () => {
    const terminal = makeTerminal()
    const generation = captureTerminalParseProgressGeneration(terminal)
    terminal.write('before\r\n')

    const parsed = waitForTerminalOutputParsed(terminal)
    terminal.write('after\r\n')
    terminal.resize(40, 10)
    await parsed

    // The 250ms settle timer resolves the wait without recording progress; only the barrier does.
    expect(hasTerminalParseProgressSince(terminal, generation)).toBe(true)
    expect(firstRows(terminal)).toEqual(['before', 'after'])
    _resetWritePipelineHealthForTests(terminal)
    terminal.dispose()
  })

  it('settles the replay wait and keeps the output queued behind it', async () => {
    const terminal = makeTerminal()
    terminal.write('before\r\n')

    const parsed = waitForTerminalReplayWritesParsed(terminal, { stallCheckMs: 60_000 })
    terminal.write('after\r\n')
    terminal.resize(40, 10)
    const settled = await Promise.race([parsed.then(() => true), delay(150).then(() => false)])

    expect(settled).toBe(true)
    expect(firstRows(terminal)).toEqual(['before', 'after'])
    terminal.dispose()
  })

  it('does not certify a live pipeline dead when a resize lands behind the stall probe', async () => {
    const terminal = makeTerminal()
    const target = makeTerminalResizedBehindFirstBarrier(terminal)
    const onCertifiedDead = vi.fn()
    terminal.write('before\r\n')

    armTerminalWriteStallWatch(target, { stallCheckMs: 20, onCertifiedDead })
    await delay(120)

    expect(onCertifiedDead).not.toHaveBeenCalled()
    expect(isTerminalWritePipelineCertifiedDead(target)).toBe(false)
    expect(firstRows(terminal)).toEqual(['before', 'after'])
    _resetWritePipelineHealthForTests(target)
    terminal.dispose()
  })

  it('releases a replay guard whose completion was lost without calling the pane wedged', async () => {
    const terminal = makeTerminal()
    const target = makeTerminalResizedBehindFirstBarrier(terminal, { dropCompletions: true })
    const ref: ReplayingPanesRef = { current: new Map() }
    const onUndeliverable = vi.fn()
    registerUndeliverableWriteHandler(target, onUndeliverable)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replayIntoTerminal only reads `id` and `terminal` from the pane.
    const pane = { id: 1, terminal: target } as unknown as ManagedPane

    replayIntoTerminal(pane, ref, 'before\r\n', { stallCheckMs: 20 })
    await delay(120)

    expect(isPaneReplaying(ref, 1)).toBe(false)
    expect(onUndeliverable).not.toHaveBeenCalled()
    expect(firstRows(terminal)).toEqual(['before', 'after'])
    _resetWritePipelineHealthForTests(target)
    terminal.dispose()
  })
})
