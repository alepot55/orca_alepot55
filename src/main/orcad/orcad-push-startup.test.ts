import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProfilePreferences } from '../persistence/loading-store/profile-preferences'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { DeviceRegistry } from '../runtime/device-registry'
import { RuntimeMobileNotificationController } from '../runtime/runtime-mobile-notification-controller'
import { PushUnregisterOutbox } from '../runtime/push/push-unregister-outbox'
import { createPushHostKeypair } from '../runtime/push/push-host-challenge-fixtures'
import { acquireProfileStateMaintenance } from '../persistence/profile-state/profile-state-access'
import { profileStateAccessPaths } from '../persistence/profile-state/profile-state-access-owner'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'

const state = vi.hoisted(() => ({
  root: '',
  controller: null as RuntimeMobileNotificationController | null,
  registry: null as DeviceRegistry | null,
  rpcStarted: false,
  profileStartupErrors: new Array<Error>(),
  onSettingsChanged: vi.fn<ProfilePreferences['onSettingsChanged']>(),
  removeSettingsListener: vi.fn(),
  startDaemon: vi.fn(async () => {}),
  browserProvider: vi.fn(async () => null),
  register: vi.fn(async () => ({ ok: true, registrationId: 'headless-registration' })),
  send: vi.fn(async () => ({ ok: true, results: [] })),
  startCodexHooks: vi.fn(),
  installManagedAgentHooks: vi.fn(async () => []),
  refreshOpenCodePlugins: vi.fn(),
  adoptLoginShellAgentHomes: vi.fn(async () => {})
}))
const hostAgentEnvironment = vi.hoisted(() => {
  const value: {
    resolvers?: CommitMessageAgentEnvironmentResolvers
    loginShell: NodeJS.ProcessEnv
  } = { loginShell: {} }
  return value
})
const profile = vi.hoisted(() => {
  const value: { settings: Partial<GlobalSettings> } = { settings: {} }
  return value
})
// Why: startup reconciles the user-global agent configs; keep it off this machine's real home.
vi.mock('../codex/codex-hook-reconcile', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startCodexHooks: state.startCodexHooks
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installManagedAgentHooks: state.installManagedAgentHooks
}))
vi.mock('../agent-hooks/local-agent-cli-presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hydrateAgentCliShellPath: async () => {}
}))
// Why: the sandbox has no user login shell; this stands in for what the host's rc files export.
vi.mock('../startup/login-shell-environment', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLoginShellEnvironment: async () => hostAgentEnvironment.loginShell
}))
vi.mock('../agent-hooks/agent-home-login-shell', () => ({
  adoptLoginShellAgentHomes: state.adoptLoginShellAgentHomes
}))
vi.mock('../opencode/opencode-status-plugin-startup-refresh', () => ({
  refreshInstalledOpenCodeStatusPlugins: state.refreshOpenCodePlugins
}))
vi.mock('./orcad-app-paths', () => ({
  resolveOrcadInstallRoot: () => state.root,
  resolveOrcadPath: () => state.root,
  resolveUserDataPath: () => state.root
}))
vi.mock('./orcad-browser-provider', () => ({ resolveOrcadBrowserProvider: state.browserProvider }))
vi.mock('./orcad-instance-lock', () => ({
  acquireOrcadInstanceLock: () => ({
    path: join(state.root, 'orcad.lock'),
    record: { pid: process.pid, startedAtMs: null, nonce: 'headless-instance' },
    release() {}
  })
}))
vi.mock('./orcad-daemon-supervision', () => ({
  startOrcadDaemon: state.startDaemon,
  stopOrcadDaemon: async () => {}
}))
vi.mock('./orcad-health', () => ({ collectOrcadHealth: async () => ({}) }))
// The runtime stub has no automation surface; orcad-automations.test.ts covers that wiring.
vi.mock('./orcad-automations', () => ({
  startOrcadAutomations: () => {},
  stopOrcadAutomationScheduler: () => {},
  orcadAutomationsKeepHostBusy: () => false
}))
// Why: the real updater would fetch rules from GitHub inside a unit test.
vi.mock('../runtime/agent-state-rules/agent-state-rules-live-update', () => ({
  startAgentStateRulesLiveUpdates: () => {}
}))
vi.mock('../daemon/daemon-init', () => ({ daemonOwnsFreshPersistentPtys: () => false }))
vi.mock('../ipc/pty', () => ({
  registerHeadlessPtyRuntime: async () => {},
  getLocalPtyProvider: () => null,
  getSshPtyProvider: () => null
}))
vi.mock('./orcad-profile-state-startup', () => ({
  createOrcadProfileStateStartup: async () => {
    const error = state.profileStartupErrors.shift()
    if (error) {
      throw error
    }
    return {
      store: {
        getSettings: () => profile.settings,
        onSettingsChanged: state.onSettingsChanged,
        flushFinalOrThrowAsync: async () => {},
        freezeWritesAsync: async () => {}
      },
      authority: {
        backend: 'sqlite',
        classification: 'neither',
        authority_mode: 'sqlite-candidate',
        runtime: 'orcad',
        migrated: false
      }
    }
  }
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  initOrcaProfilePaths() {},
  ensureActiveOrcaProfile: () => ({
    dataFile: join(state.root, 'profile.json'),
    stateDatabaseFile: join(state.root, 'profile-state.db'),
    profile: { id: 'headless-profile' }
  })
}))
vi.mock('../ssh/ssh-host-key-store', () => ({ initSshHostKeyStoreFile() {} }))
vi.mock('../server/serve-readiness', () => ({
  ServeReadinessPublisher: class {
    async publish() {}
  }
}))
vi.mock('../runtime/orca-runtime', () => ({
  OrcaRuntimeService: class {
    getRuntimeId() {
      return 'headless-runtime'
    }
    rehydrateClientHostedBrowserPages() {}
    async refreshRestoredOrchestrationAuthority() {}
    async reconcileLegacyWorkerTerminals() {}
    async stopLegacyWorkerTerminalRecovery() {}
    syncWindowGraph() {}
    setCommitMessageAgentEnvironmentResolvers(resolvers: CommitMessageAgentEnvironmentResolvers) {
      hostAgentEnvironment.resolvers = resolvers
    }
    setMobilePushRegistrar(
      registrar: Parameters<RuntimeMobileNotificationController['setPushRegistrar']>[0]
    ) {
      state.controller!.setPushRegistrar(registrar)
    }
    onNotificationDispatched(
      listener: Parameters<RuntimeMobileNotificationController['onDispatched']>[0]
    ) {
      return state.controller!.onDispatched(listener)
    }
  }
}))
vi.mock('../runtime/runtime-rpc', () => ({
  OrcaRuntimeRpcServer: class {
    async start() {
      state.rpcStarted = true
    }
    async stop() {
      state.rpcStarted = false
    }
    getWebSocketEndpoint() {
      return null
    }
    getE2EEKeypair() {
      expect(state.rpcStarted).toBe(true)
      return createPushHostKeypair()
    }
    getDeviceRegistry() {
      return state.registry
    }
    getPushUnregisterOutbox() {
      return new PushUnregisterOutbox(state.root)
    }
    setOnPushUnregisterQueued() {}
  }
}))
vi.mock('../runtime/push/push-gateway-client', () => ({
  PushGatewayClient: class {
    registerDevice = state.register
    send = state.send
    async deleteDevice() {
      return { deleted: true, retryable: false }
    }
  }
}))

beforeEach(() => {
  state.onSettingsChanged.mockReturnValue(state.removeSettingsListener)
})

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  state.profileStartupErrors.length = 0
  hostAgentEnvironment.resolvers = undefined
  hostAgentEnvironment.loginShell = {}
  profile.settings = {}
  vi.clearAllMocks()
})

it('refuses recovery overlap before initializing the browser provider or runtime', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-recovery-'))
  const maintenance = acquireProfileStateMaintenance(state.root)
  const { startOrcad } = await import('./orcad-entry')
  try {
    await expect(startOrcad({ noPairing: true, json: true })).rejects.toThrow()
    expect(state.browserProvider).not.toHaveBeenCalled()
    expect(state.rpcStarted).toBe(false)
  } finally {
    maintenance.release()
  }
})

it('starts push after RPC identity is available and stops dispatch on shutdown', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-push-'))
  state.controller = new RuntimeMobileNotificationController()
  state.registry = new DeviceRegistry(state.root)
  const phone = state.registry.addDevice('headless-phone', 'mobile')
  const { startOrcad } = await import('./orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    const result = await state.controller.registerPushDevice({
      deviceId: phone.deviceId,
      platform: 'android',
      token: 'test-token',
      filter: {
        onlyWhenDesktopAway: true
      }
    })
    expect(result).toMatchObject({ registered: true })
    expect(state.registry.getDevice(phone.deviceId)?.pushRegistration?.expiresAt).toBeGreaterThan(
      Date.now()
    )
    state.controller.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'QA',
      body: 'QA'
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(state.send).toHaveBeenCalledTimes(1)
  } finally {
    await host.stop()
  }
  expect(readdirSync(profileStateAccessPaths(state.root).participants)).toEqual([])
  acquireProfileStateMaintenance(state.root).release()
  expect(state.controller.getListenerCount()).toBe(0)
  expect(state.rpcStarted).toBe(false)
  expect(state.onSettingsChanged).toHaveBeenCalledOnce()
  expect(state.removeSettingsListener).toHaveBeenCalledOnce()
  await host.stop()
  expect(state.removeSettingsListener).toHaveBeenCalledOnce()
  expect(await state.controller.registerPushDevice({} as never)).toMatchObject({
    registered: false
  })
})

it('releases admission when host setup fails before a runtime exists', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-setup-failure-'))
  state.profileStartupErrors.push(new Error('profile startup failed'))
  const { startOrcad } = await import('./orcad-entry')
  await expect(startOrcad()).rejects.toThrow('profile startup failed')
  expect(readdirSync(profileStateAccessPaths(state.root).participants)).toEqual([])
  acquireProfileStateMaintenance(state.root).release()
})

it('serves RPC without waiting for browser discovery', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-browser-pending-'))
  let finishDiscovery!: () => void
  state.browserProvider.mockReturnValueOnce(
    new Promise<null>((resolve) => {
      finishDiscovery = () => resolve(null)
    })
  )
  const { startOrcad } = await import('./orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  expect(host.managedStop).toMatchObject({
    runtimeId: 'headless-runtime',
    instance: { pid: process.pid, nonce: 'headless-instance' }
  })
  finishDiscovery()
  await host.stop()
  expect(readdirSync(profileStateAccessPaths(state.root).participants)).toEqual([])
})

it('unsubscribes settings when daemon startup fails after hook setup', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-daemon-failure-'))
  state.startDaemon.mockRejectedValueOnce(new Error('daemon setup failed'))
  const { startOrcad } = await import('./orcad-entry')
  await expect(startOrcad()).rejects.toThrow('daemon setup failed')
  expect(state.onSettingsChanged).toHaveBeenCalledOnce()
  expect(state.removeSettingsListener).toHaveBeenCalledOnce()
  expect(readdirSync(profileStateAccessPaths(state.root).participants)).toEqual([])
  acquireProfileStateMaintenance(state.root).release()
})

// Why: a freshly managed SSH host starts orcad on connect; without this its agents never report status.
it('installs agent status hooks on the host when it starts', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-hooks-'))
  const { startOrcad } = await import('./orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    expect(state.startCodexHooks).toHaveBeenCalledOnce()
    // orcad launches Codex on the real ~/.codex; it has no Orca-managed account homes.
    expect(state.startCodexHooks.mock.calls[0]![0].resolveLaunchHome()).toBeNull()
    await vi.waitFor(() =>
      expect(state.installManagedAgentHooks).toHaveBeenCalledWith(
        profile.settings,
        expect.objectContaining({ shouldHydrateShellPath: true })
      )
    )
    expect(state.refreshOpenCodePlugins).toHaveBeenCalledWith(profile.settings)
    // Grok/Kiro homes set only in login profiles must be known before their installers run.
    expect(state.adoptLoginShellAgentHomes.mock.invocationCallOrder[0]).toBeLessThan(
      state.installManagedAgentHooks.mock.invocationCallOrder[0]!
    )
  } finally {
    await host.stop()
  }
})

it('leaves agent configs alone when status hooks are off', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-hooks-off-'))
  profile.settings = { agentStatusHooksEnabled: false }
  const { startOrcad } = await import('./orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    expect(state.installManagedAgentHooks).not.toHaveBeenCalled()
    expect(state.startCodexHooks.mock.calls[0]![0].isEnabled()).toBe(false)
  } finally {
    await host.stop()
  }
})

const LOGIN_ONLY_VARIABLE = 'ORCA_TEST_LOGIN_ONLY_VALUE'

// Why: orcad starts from a non-login SSH command, so a variable the login shell exports (a proxy,
// a token) reaches no generation agent unless the host base-environment resolver is installed.
// The agent is run by absolute path, so the result does not depend on how PATH is hydrated.
const loginVariableCases: [string, Partial<GlobalSettings>, string][] = [
  ['inherits the login-shell variables by default', {}, 'from-login-shell'],
  [
    'drops them when the host turns shell inheritance off',
    { nativeChatInheritShellEnvironment: false },
    'unset'
  ],
  [
    'keeps a variable the host lists when inheritance is off',
    {
      nativeChatInheritShellEnvironment: false,
      nativeChatShellEnvironmentVariables: [LOGIN_ONLY_VARIABLE]
    },
    'from-login-shell'
  ]
]

it.runIf(process.platform !== 'win32').each(loginVariableCases)(
  'commit message generation %s',
  async (_name, settings, expectedValue) => {
    state.root = mkdtempSync(join(tmpdir(), 'orca-headless-commit-agent-'))
    const agent = join(state.root, 'echo-login-variable-agent')
    writeFileSync(
      agent,
      `#!/bin/sh\ncat >/dev/null\necho "value=\${${LOGIN_ONLY_VARIABLE}:-unset}"\n`
    )
    chmodSync(agent, 0o755)
    profile.settings = settings
    hostAgentEnvironment.loginShell = {
      PATH: process.env.PATH,
      [LOGIN_ONLY_VARIABLE]: 'from-login-shell'
    }
    const { startOrcad } = await import('./orcad-entry')
    const host = await startOrcad({ noPairing: true, json: true })
    try {
      const { prepareLocalCommitMessageAgentEnv } =
        await import('../text-generation/commit-message-agent-environment')
      const { generateCommitMessageFromContext } =
        await import('../text-generation/commit-message-text-generation')
      const localEnv = await prepareLocalCommitMessageAgentEnv(
        'custom',
        hostAgentEnvironment.resolvers
      )
      expect(localEnv.ok).toBe(true)

      await expect(
        generateCommitMessageFromContext(
          { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
          { agentId: 'custom', model: '', customAgentCommand: agent },
          { kind: 'local', cwd: state.root, env: localEnv.ok ? localEnv.env : undefined }
        )
      ).resolves.toMatchObject({ success: true, message: `value=${expectedValue}` })
    } finally {
      await host.stop()
    }
  }
)
