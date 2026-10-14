// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const { toastWarning } = vi.hoisted(() => ({
  // Why: typed to what tests read back; the code's onClick ignores sonner's click event.
  toastWarning: vi.fn<(message: string, data?: { action?: { onClick: () => void } }) => void>()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: toastWarning } }))
vi.mock('../components/terminal/terminal-provider-snapshot-capability', () => ({
  collectTerminalProviderSnapshotPtyIds: () => [],
  refreshTerminalProviderSnapshotCapabilities: async () => undefined
}))
vi.mock('../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    startupWorktreeRefreshCompleted: false,
    terminalStartupRestorationReady: false,
    workspaceSessionReady: false
  }))
  return { useAppStore }
})

import { toast } from 'sonner'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import { withRemoteRuntimeTailscaleHint } from '../../../shared/remote-runtime-tailscale-hint'
import { useAppStore } from '../store'
import { recoverFromDegradedStartup } from './startup-degraded-recovery'

function recover(args: {
  error?: unknown
  reconnectStarted?: boolean
  isCancelled: () => boolean
  reconnectPersistedTerminals: () => Promise<void>
}): Promise<void> {
  return recoverFromDegradedStartup({
    error: new Error('hydration failed'),
    uiHydrated: true,
    reconnectStarted: false,
    hydratePersistedUI: vi.fn(),
    abortSignal: new AbortController().signal,
    ...args
  })
}

describe('recoverFromDegradedStartup', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    useAppStore.setState({ terminalStartupRestorationReady: false, workspaceSessionReady: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: {
          awaitFirstWindowStartupServices: async () => undefined,
          recoverLegacyWorkerTerminalsForRendererStartup: async () => undefined,
          relaunch: vi.fn()
        }
      }
    })
  })

  it('releases terminal startup restoration once the degraded reconnect succeeds', async () => {
    await recover({
      isCancelled: () => false,
      reconnectPersistedTerminals: async () => {
        useAppStore.setState({ workspaceSessionReady: true })
      }
    })

    expect(useAppStore.getState().terminalStartupRestorationReady).toBe(true)
  })

  it('leaves the flag to the newer pass when this one was cancelled mid-reconnect', async () => {
    let cancelled = false
    await recover({
      isCancelled: () => cancelled,
      reconnectPersistedTerminals: async () => {
        cancelled = true
      }
    })

    expect(useAppStore.getState().terminalStartupRestorationReady).toBe(false)
  })
})

describe('recoverFromDegradedStartup in a paired web client', () => {
  // The web transport's rejection when the paired host refuses or drops the socket at boot.
  const unreachable = new Error('Could not connect to the remote Orca runtime.')
  const AUTO_RELOAD_MARKER_KEY = 'orca:paired-host-unreachable-auto-reload-at'
  let statusListeners: ((snapshot: RuntimeHostStatusSnapshot) => void)[]
  let statusSnapshots: RuntimeHostStatusSnapshot[]
  let getStatusSnapshots: ReturnType<typeof vi.fn>
  let reload: ReturnType<typeof vi.fn>
  let reconnectPersistedTerminals: Mock<() => Promise<void>>
  let storedItems: Map<string, string>
  let failingStorageMethod: 'getItem' | 'setItem' | null

  // Why: spies on happy-dom's Storage survive restoreAllMocks, so tests own the whole store.
  const sessionStorageStub = {
    getItem: (key: string): string | null => {
      if (failingStorageMethod === 'getItem') {
        throw new Error('storage blocked')
      }
      return storedItems.get(key) ?? null
    },
    setItem: (key: string, value: string): void => {
      if (failingStorageMethod === 'setItem') {
        throw new Error('storage blocked')
      }
      storedItems.set(key, value)
    },
    removeItem: (key: string): void => {
      storedItems.delete(key)
    }
  }

  const snapshot = (
    transport: RuntimeHostStatusSnapshot['transport'],
    retired?: true
  ): RuntimeHostStatusSnapshot => ({
    environmentId: 'env-1',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 0,
    status: null,
    verification: 'checking',
    transport,
    ...(retired ? { retired } : {})
  })

  const publish = (next: RuntimeHostStatusSnapshot): void => {
    for (const listener of statusListeners) {
      listener(next)
    }
  }

  const bootUnreachable = async (error: unknown = unreachable): Promise<void> => {
    await recover({ error, isCancelled: () => false, reconnectPersistedTerminals })
    // Let the getStatusSnapshots() continuation run.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const tryAgain = (toastIndex: number): void => {
    const onClick = toastWarning.mock.calls[toastIndex]?.[1]?.action?.onClick
    if (!onClick) {
      throw new Error(`toast ${toastIndex} has no Try again action`)
    }
    onClick()
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(toast.error).mockClear()
    toastWarning.mockClear()
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    useAppStore.setState({ terminalStartupRestorationReady: false, workspaceSessionReady: false })
    reconnectPersistedTerminals = vi.fn(async () => {
      useAppStore.setState({ workspaceSessionReady: true })
    })
    storedItems = new Map()
    failingStorageMethod = null
    vi.stubGlobal('sessionStorage', sessionStorageStub)
    statusListeners = []
    statusSnapshots = []
    getStatusSnapshots = vi.fn(async () => statusSnapshots)
    reload = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: {
          awaitFirstWindowStartupServices: async () => undefined,
          recoverLegacyWorkerTerminalsForRendererStartup: async () => undefined,
          relaunch: vi.fn(),
          reload
        },
        runtimeEnvironments: {
          getStatusSnapshots,
          onStatusChanged: (listener: (snapshot: RuntimeHostStatusSnapshot) => void) => {
            statusListeners.push(listener)
            return () => undefined
          }
        }
      }
    })
    return () => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it.each([
    {
      name: 'a refused connection',
      message: withRemoteRuntimeTailscaleHint(
        'Could not connect to the remote Orca runtime.',
        'ws://192.168.1.20:6768'
      )
    },
    {
      name: 'a connect timeout',
      message: withRemoteRuntimeTailscaleHint(
        'Timed out while connecting to the remote Orca runtime.',
        'wss://studio.example.ts.net'
      )
    },
    { name: 'a dropped socket', message: 'Remote Orca runtime connection interrupted.' }
  ])('reports $name as an unreachable host instead of a failed session restore', async (row) => {
    await bootUnreachable(new Error(row.message))

    expect(toast.error).not.toHaveBeenCalled()
    expect(toastWarning).toHaveBeenCalledWith("Can't reach Orca server", expect.anything())
    // The shell still mounts offline behind the toast.
    expect(reconnectPersistedTerminals).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState()).toMatchObject({
      workspaceSessionReady: true,
      terminalStartupRestorationReady: true
    })
  })

  it('keeps the session-restore failure for the same error outside the web client', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', undefined)

    await bootUnreachable()

    expect(toast.error).toHaveBeenCalledWith('Session restore failed', expect.anything())
    expect(toastWarning).not.toHaveBeenCalled()
    expect(statusListeners).toHaveLength(0)
    expect(getStatusSnapshots).not.toHaveBeenCalled()
  })

  it('reloads into a clean hydration once the host answers again', async () => {
    await bootUnreachable()

    publish(snapshot('connecting'))
    expect(reload).not.toHaveBeenCalled()
    publish(snapshot('ready'))
    publish(snapshot('ready'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads when the transport was already ready before the listener existed', async () => {
    statusSnapshots = [snapshot('ready')]

    await bootUnreachable()

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('ignores a retired environment that reports a ready transport', async () => {
    statusSnapshots = [snapshot('ready', true)]

    await bootUnreachable()
    publish(snapshot('ready', true))

    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads automatically at most once in a row', async () => {
    // As in a browser, the marker is written before the reloaded page's time origin.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Math.floor(performance.timeOrigin) - 1_500)
    await bootUnreachable()
    publish(snapshot('ready'))
    expect(reload).toHaveBeenCalledTimes(1)
    vi.useRealTimers()

    // The auto-reloaded page fails again: it says so but leaves the retry to the user.
    await bootUnreachable()
    publish(snapshot('ready'))
    expect(toastWarning).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(1)
    tryAgain(1)
    tryAgain(1)
    expect(reload).toHaveBeenCalledTimes(2)

    // The page the user's retry opened may auto-reload again.
    await bootUnreachable()
    publish(snapshot('ready'))
    expect(reload).toHaveBeenCalledTimes(3)
  })

  it.each([
    { markerAgeMs: 1_500, autoReloads: 0 },
    { markerAgeMs: 29_000, autoReloads: 0 },
    { markerAgeMs: 31_000, autoReloads: 1 }
  ])(
    'auto-reloads $autoReloads times after a marker written $markerAgeMs ms before this page loaded',
    async ({ markerAgeMs, autoReloads }) => {
      storedItems.set(AUTO_RELOAD_MARKER_KEY, String(performance.timeOrigin - markerAgeMs))

      await bootUnreachable()
      publish(snapshot('ready'))

      expect(reload).toHaveBeenCalledTimes(autoReloads)
    }
  )

  it.each(['getItem', 'setItem'] as const)(
    'does not auto-reload when session storage %s fails',
    async (method) => {
      failingStorageMethod = method

      await bootUnreachable()
      publish(snapshot('ready'))

      expect(toastWarning).toHaveBeenCalledTimes(1)
      expect(reload).not.toHaveBeenCalled()
      tryAgain(0)
      tryAgain(0)
      expect(reload).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps the session-restore failure for genuine hydration failures', async () => {
    const noReconnect = async (): Promise<void> => undefined
    // A host-coded reply, a non-transport failure, and a transport loss after reconnect began.
    await recover({
      error: Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
        code: 'runtime_unavailable'
      }),
      isCancelled: () => false,
      reconnectPersistedTerminals: noReconnect
    })
    await recover({ isCancelled: () => false, reconnectPersistedTerminals: noReconnect })
    await recover({
      error: unreachable,
      reconnectStarted: true,
      isCancelled: () => false,
      reconnectPersistedTerminals: noReconnect
    })

    expect(toast.error).toHaveBeenCalledTimes(3)
    expect(toast.error).toHaveBeenCalledWith('Session restore failed', expect.anything())
    expect(toastWarning).not.toHaveBeenCalled()
    publish(snapshot('ready'))
    expect(reload).not.toHaveBeenCalled()
  })
})
