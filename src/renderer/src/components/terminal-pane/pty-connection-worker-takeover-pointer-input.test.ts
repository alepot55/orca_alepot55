import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { connectPanePty } from './pty-connection'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createManager,
  createMockTransport,
  createPane,
  leafIdForPane,
  type MockPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'

const {
  notifyCodexPaneBoundForStaleSweep,
  reportWorkerTerminalUserInput,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo
} = vi.hoisted(() => ({
  notifyCodexPaneBoundForStaleSweep: vi.fn(),
  reportWorkerTerminalUserInput: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []

vi.mock('@/lib/worker-terminal-takeover-report', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reportWorkerTerminalUserInput
}))

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: () => () => {}
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

/** Mirrors xterm's CoreService.triggerDataEvent: onUserInput fires only for user input, then onData. */
async function connectPaneWithXtermUserInput(pane: MockPane): Promise<{
  sendAutoReply: (data: string) => void
  sendUserInput: (data: string) => void
  transport: MockTransport
}> {
  const userInputListeners = new Set<() => void>()
  const onDataListeners: ((data: string) => void)[] = []
  pane.terminal.onData.mockImplementation((listener: (data: string) => void) => {
    onDataListeners.push(listener)
    return { dispose: vi.fn() }
  })
  Object.assign(pane.terminal, {
    _core: {
      coreService: {
        onUserInput: (listener: () => void) => {
          userInputListeners.add(listener)
          return { dispose: () => userInputListeners.delete(listener) }
        }
      }
    }
  })
  const transport = createMockTransport('pty-worker')
  transportFactoryQueue.push(transport)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
  const args = [
    pane,
    createManager(1),
    buildPaneConnectionDeps(() => mockStoreState)
  ] as unknown as Parameters<typeof connectPanePty>
  connectPanePty(...args)
  await flushAsyncTicks()
  const sendAutoReply = (data: string): void => {
    for (const listener of onDataListeners) {
      listener(data)
    }
  }
  return {
    transport,
    sendAutoReply,
    sendUserInput: (data) => {
      for (const listener of userInputListeners) {
        listener()
      }
      sendAutoReply(data)
    }
  }
}

describe('connectPanePty worker takeover from pointer input', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    transportFactoryQueue = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('does not take a worker over when the user scrolls, clicks or hovers a mouse-tracking TUI', async () => {
    const pane = createPane(1)
    const { sendUserInput, transport } = await connectPaneWithXtermUserInput(pane)

    const mouseReports = [
      '\x1b[<64;10;5M', // wheel up
      '\x1b[<65;10;5M', // wheel down
      '\x1b[<0;10;5M', // click press
      '\x1b[<0;10;5m', // click release
      '\x1b[<35;12;6M' // hover motion
    ]
    for (const report of mouseReports) {
      sendUserInput(report)
    }

    expect(reportWorkerTerminalUserInput).not.toHaveBeenCalled()
    // Scrolling still reaches the TUI.
    expect(transport.sendInput).toHaveBeenCalledWith('\x1b[<64;10;5M', 'driving')
  })

  it('does not take a worker over when wheel notches become cursor keys on the alt screen', async () => {
    const pane = createPane(1)
    pane.terminal.buffer.active.type = 'alternate'
    const { sendUserInput } = await connectPaneWithXtermUserInput(pane)

    sendUserInput('\x1b[A')
    sendUserInput('\x1bOB')

    expect(reportWorkerTerminalUserInput).not.toHaveBeenCalled()
  })

  it('does not take a worker over from xterm auto-replies to focus changes and terminal queries', async () => {
    const pane = createPane(1)
    const { sendAutoReply, transport } = await connectPaneWithXtermUserInput(pane)

    sendAutoReply('\x1b[I') // focus in
    sendAutoReply('\x1b[O') // focus out
    sendAutoReply('\x1b[?1;2c') // DA1
    sendAutoReply('\x1b[5;10R') // CPR

    expect(reportWorkerTerminalUserInput).not.toHaveBeenCalled()
    // Replies still reach the TUI, labelled as replies rather than driving input.
    expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I', 'query-reply')
    expect(transport.sendInputImmediate).toHaveBeenCalledWith('\x1b[?1;2c')
  })

  it('takes a worker over when the user types', async () => {
    const pane = createPane(1)
    const { sendUserInput } = await connectPaneWithXtermUserInput(pane)

    sendUserInput('\x1b[A')
    sendUserInput('y')

    expect(reportWorkerTerminalUserInput).toHaveBeenCalledWith(
      makePaneKey('tab-1', leafIdForPane(1)),
      null
    )
    expect(reportWorkerTerminalUserInput).toHaveBeenCalledTimes(2)
  })
})
