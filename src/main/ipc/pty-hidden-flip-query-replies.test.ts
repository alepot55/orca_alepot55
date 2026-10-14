import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerPtyHandlers } from './pty/register-handlers'
import { TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS } from '../../shared/terminal-scrollback-policy'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test doubles implement only the members these delivery paths read.
const testDouble = <T>(value: unknown): T => value as T

const CURSOR_AND_DEVICE_QUERIES = 'ready> \x1b[6n\x1b[c'
const EXPECTED_REPLIES = ['\x1b[1;8R', '\x1b[?1;2c']

describe('terminal queries queued for the view when the pane hides before the flush', () => {
  const {
    handlers,
    mainWindow,
    installObservableDaemonTestProvider,
    getPtySetHiddenRendererPtyListener,
    getPtySetDeliveryInterestListener
  } = setupPtyIpcSuite()

  async function spawnWithRealRuntime() {
    const daemon = installObservableDaemonTestProvider()
    const runtime = new OrcaRuntimeService(
      testDouble({
        getRepo: () => undefined,
        getRepos: () => [],
        addRepo: () => {},
        updateRepo: () => undefined,
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        setWorktreeMeta: () => undefined,
        removeWorktreeMeta: () => {},
        getGitHubCache: () => ({ pr: {}, issue: {} }),
        getSettings: () => ({
          workspaceDir: '/tmp/workspaces',
          nestWorkspaces: false,
          refreshLocalBaseRefOnWorktreeCreate: false,
          branchPrefix: 'none',
          branchPrefixCustom: '',
          terminalMainSideEffectAuthority: true,
          terminalHiddenDeliveryGate: true,
          terminalModelQueryAuthority: true
        })
      })
    )
    registerPtyHandlers(testDouble(mainWindow), runtime)
    const { id } = testDouble<{ id: string }>(
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, sessionId: 'daemon-session' })
    )
    const repliesTo = (ptyId: string): string[] =>
      daemon.write.mock.calls
        .filter((call: unknown[]) => call[0] === ptyId)
        .map((call: unknown[]) => String(call[1]))
    return { daemon, runtime, id, repliesTo }
  }

  it('answers once from the model when the hidden mark drops the queued query bytes', async () => {
    const { daemon, runtime, id, repliesTo } = await spawnWithRealRuntime()

    // Ingested while visible, so the view owns the replies; the batch timer has not flushed yet.
    daemon.emitData(id, CURSOR_AND_DEVICE_QUERIES)
    getPtySetHiddenRendererPtyListener()(null, { id, hidden: true })
    await runtime.serializeMainTerminalBuffer(id)

    expect(repliesTo(id)).toEqual(EXPECTED_REPLIES)

    getPtySetHiddenRendererPtyListener()(null, { id, hidden: false })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await runtime.serializeMainTerminalBuffer(id)
    expect(repliesTo(id)).toEqual(EXPECTED_REPLIES)
  })

  it('answers once from the model when the flush drops bytes queued for a sidecar', async () => {
    const { daemon, runtime, id, repliesTo } = await spawnWithRealRuntime()
    getPtySetHiddenRendererPtyListener()(null, { id, hidden: true })
    getPtySetDeliveryInterestListener()(null, { id, interested: true })

    daemon.emitData(id, CURSOR_AND_DEVICE_QUERIES)
    // Sidecar leaves before the batch flush: the gate now drops what it queued.
    getPtySetDeliveryInterestListener()(null, { id, interested: false })

    await vi.waitFor(async () => {
      await runtime.serializeMainTerminalBuffer(id)
      expect(repliesTo(id)).toEqual(EXPECTED_REPLIES)
    })
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
      'pty:data',
      expect.objectContaining({ id, data: CURSOR_AND_DEVICE_QUERIES })
    )
  })

  // The model answers from its state after the whole drop, so a cursor or mode report is only
  // true when nothing moved that state after the query.
  it('skips a cursor report when output follows the query in the dropped bytes', async () => {
    const { daemon, runtime, id, repliesTo } = await spawnWithRealRuntime()

    daemon.emitData(id, 'ab\x1b[6n\x1b[ccd')
    getPtySetHiddenRendererPtyListener()(null, { id, hidden: true })
    await runtime.serializeMainTerminalBuffer(id)

    expect(repliesTo(id)).toEqual(['\x1b[?1;2c'])
  })

  it('skips a cursor report when a later queued chunk moved the cursor', async () => {
    const { daemon, runtime, id, repliesTo } = await spawnWithRealRuntime()

    daemon.emitData(id, 'ab\x1b[6n')
    daemon.emitData(id, '\r\nline2\r\nline3')
    getPtySetHiddenRendererPtyListener()(null, { id, hidden: true })
    await runtime.serializeMainTerminalBuffer(id)

    expect(repliesTo(id)).toEqual([])
  })

  it('skips a cursor report when the pending cap already discarded the queued output', async () => {
    const { daemon, runtime, id, repliesTo } = await spawnWithRealRuntime()

    // Over the cap the queue keeps only query bytes, so where the drop ends is unknown.
    daemon.emitData(id, `${'x'.repeat(TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS + 1)}\x1b[6n\x1b[c`)
    getPtySetHiddenRendererPtyListener()(null, { id, hidden: true })
    await runtime.serializeMainTerminalBuffer(id)

    expect(repliesTo(id)).toEqual(['\x1b[?1;2c'])
  })

  it('skips a cursor report when output arrived after the queued bytes but before the flush', async () => {
    const { daemon, runtime, id, repliesTo } = await spawnWithRealRuntime()
    getPtySetHiddenRendererPtyListener()(null, { id, hidden: true })
    getPtySetDeliveryInterestListener()(null, { id, interested: true })

    daemon.emitData(id, CURSOR_AND_DEVICE_QUERIES)
    getPtySetDeliveryInterestListener()(null, { id, interested: false })
    // Dropped on arrival and parsed by the model before the flush replays the queued queries.
    daemon.emitData(id, '\r\nmore')

    await vi.waitFor(async () => {
      await runtime.serializeMainTerminalBuffer(id)
      expect(repliesTo(id)).toEqual(['\x1b[?1;2c'])
    })
  })
})
