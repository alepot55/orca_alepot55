import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RuntimeTerminalDataMeta } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  makeRequest,
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe,
  stubRuntime
} from './terminal-multiplex-test-harness'

describe('terminal multiplex RPC', () => {
  it('keeps layout versions out of the output sequence domain', async () => {
    let dataListener: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | undefined
    const harness = startDesktopMultiplexSubscribe({
      getLayout: vi.fn().mockReturnValue({ seq: 675 }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue({
        data: 'restored terminal',
        cols: 120,
        rows: 40,
        source: 'renderer'
      }),
      subscribeToTerminalData: vi.fn((_ptyId, listener) => {
        dataListener = listener
        return vi.fn()
      })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(
        harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toBe(true)
    )

    const subscribed = harness.messages
      .map((message) => JSON.parse(message).result)
      .find((event) => event?.type === 'subscribed')
    const snapshotStart = harness.binaryFrames
      .map(decodeTerminalStreamFrame)
      .find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)
    expect(subscribed.seq).toBe(675)
    if (!snapshotStart) {
      throw new Error('Missing multiplex snapshot start frame')
    }
    const snapshotPayload = decodeTerminalStreamJson(snapshotStart.payload)
    expect(snapshotPayload).toMatchObject({ kind: 'scrollback' })
    expect(snapshotPayload).not.toHaveProperty('seq')

    harness.binaryFrames.splice(0)
    dataListener?.('live', { seq: 4, rawLength: 4 })
    await vi.waitFor(() =>
      expect(
        harness.binaryFrames.some((bytes) => {
          const frame = decodeTerminalStreamFrame(bytes)
          return frame?.opcode === TerminalStreamOpcode.Output && frame.seq === 4
        })
      ).toBe(true)
    )

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('delivers each terminal query to the attaching viewer once, including ones the snapshot covers', async () => {
    let dataListener: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | undefined
    let resolveSnapshot: (value: {
      data: string
      cols: number
      rows: number
      seq: number
    }) => void = () => {}
    const harness = startDesktopMultiplexSubscribe({
      serializeTerminalBuffer: vi.fn(
        () =>
          new Promise<{ data: string; cols: number; rows: number; seq: number }>((resolve) => {
            resolveSnapshot = resolve
          })
      ),
      subscribeToTerminalData: vi.fn((_ptyId, listener) => {
        dataListener = listener
        return vi.fn()
      })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.runtime.serializeTerminalBuffer).toHaveBeenCalled())

    // Main's model yielded both queries to the viewer at ingestion; the snapshot covers the first.
    const covered = 'orb> \x1b[6n'
    const uncovered = 'more\x1b[c'
    dataListener?.(covered, { seq: covered.length, rawLength: covered.length })
    const endSeq = covered.length + uncovered.length
    dataListener?.(uncovered, { seq: endSeq, rawLength: uncovered.length })
    resolveSnapshot({ data: 'orb> ', cols: 120, rows: 40, seq: covered.length })

    const outputText = (): string =>
      harness.binaryFrames
        .map(decodeTerminalStreamFrame)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
    await vi.waitFor(() => expect(outputText()).toContain(uncovered))
    expect(outputText().split('\x1b[6n')).toHaveLength(2)
    expect(outputText().split('\x1b[c')).toHaveLength(2)
    // Seq 0 means unsequenced: the client's snapshot-seq trimming must not slice the replay off.
    const replayFrame = harness.binaryFrames
      .map(decodeTerminalStreamFrame)
      .find(
        (frame) =>
          frame?.opcode === TerminalStreamOpcode.Output &&
          decodeTerminalStreamText(frame.payload).includes('\x1b[6n')
      )
    expect(replayFrame?.seq).toBe(0)

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('re-arms the snapshot escape tail after the query replay so a split query still completes', async () => {
    let dataListener: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | undefined
    let resolveSnapshot: (value: {
      data: string
      cols: number
      rows: number
      seq: number
      pendingEscapeTailAnsi: string
    }) => void = () => {}
    const harness = startDesktopMultiplexSubscribe({
      serializeTerminalBuffer: vi.fn(
        () =>
          new Promise<{
            data: string
            cols: number
            rows: number
            seq: number
            pendingEscapeTailAnsi: string
          }>((resolve) => {
            resolveSnapshot = resolve
          })
      ),
      subscribeToTerminalData: vi.fn((_ptyId, listener) => {
        dataListener = listener
        return vi.fn()
      })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.runtime.serializeTerminalBuffer).toHaveBeenCalled())

    // The snapshot covers 'x \x1b[c' and ends inside '\x1b[6n', which it ships as its escape tail.
    dataListener?.('x \x1b[c', { seq: 5, rawLength: 5 })
    dataListener?.('\x1b[6', { seq: 8, rawLength: 3 })
    dataListener?.('n tail', { seq: 14, rawLength: 6 })
    resolveSnapshot({ data: 'x ', cols: 120, rows: 40, seq: 8, pendingEscapeTailAnsi: '\x1b[6' })

    const outputFrames = (): { seq: number; text: string }[] =>
      harness.binaryFrames
        .map(decodeTerminalStreamFrame)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => ({
          seq: frame?.seq ?? -1,
          text: frame ? decodeTerminalStreamText(frame.payload) : ''
        }))
    await vi.waitFor(() => expect(outputFrames()).toHaveLength(2))
    // Client writes the tail last; the replay's ESC aborts it, so the replay must end by rewriting it.
    expect(outputFrames()).toEqual([
      { seq: 0, text: '\x1b[c\x1b[6' },
      { seq: 14, text: 'n tail' }
    ])

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('flushes output buffered during initial multiplex snapshot once', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const registry = createSubscriptionRegistryDouble()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
      let resolveSnapshot: (value: { data: string; cols: number; rows: number }) => void = () => {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              resolveSnapshot = resolve
            })
        ),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
        registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
        cleanupSubscription: vi.fn(registry.cleanupSubscription),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered-output-on-subscribe',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        }
      )

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      dataListenerRef.current?.('starting shell\r\n', {
        seq: 16,
        rawLength: 16
      })
      resolveSnapshot({ data: '', cols: 120, rows: 40 })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const output = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(output).toBe('starting shell\r\n')

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops buffered multiplex output already covered by the initial snapshot seq', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const registry = createSubscriptionRegistryDouble()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
      let resolveSnapshot: (value: {
        data: string
        cols: number
        rows: number
        seq: number
      }) => void = () => {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{
              data: string
              cols: number
              rows: number
              seq: number
            }>((resolve) => {
              resolveSnapshot = resolve
            })
        ),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
        registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
        cleanupSubscription: vi.fn(registry.cleanupSubscription),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered-output-covered-by-snapshot',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        }
      )

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      const startupLine = 'starting shell\r\n'
      dataListenerRef.current?.(startupLine, {
        seq: startupLine.length,
        rawLength: startupLine.length
      })
      resolveSnapshot({
        data: startupLine,
        cols: 120,
        rows: 40,
        seq: startupLine.length
      })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const outputFrames = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      const snapshotStart = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)
      expect(snapshotStart && decodeTerminalStreamJson(snapshotStart.payload)).toMatchObject({
        seq: startupLine.length
      })
      expect(outputFrames).toHaveLength(0)

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays only buffered multiplex output not covered by the initial snapshot seq', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const registry = createSubscriptionRegistryDouble()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
      let resolveSnapshot: (value: {
        data: string
        cols: number
        rows: number
        seq: number
      }) => void = () => {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{
              data: string
              cols: number
              rows: number
              seq: number
            }>((resolve) => {
              resolveSnapshot = resolve
            })
        ),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
        registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
        cleanupSubscription: vi.fn(registry.cleanupSubscription),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered-output-partially-covered-by-snapshot',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        }
      )

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      const buffered = 'hello world'
      dataListenerRef.current?.(buffered, {
        seq: buffered.length,
        rawLength: buffered.length
      })
      resolveSnapshot({
        data: 'hello',
        cols: 120,
        rows: 40,
        seq: 'hello'.length
      })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const output = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(output).toBe(' world')

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })
})
