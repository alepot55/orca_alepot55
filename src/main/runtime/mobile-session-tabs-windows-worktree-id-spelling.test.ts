import { describe, expect, it, vi } from 'vitest'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService, listWorktrees, listWorktreesSharedStrict, listWorktreesStrict } =
  await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

// A Windows workspace the host stores with backslashes; clients may spell it with forward slashes.
const STORED_ID = String.raw`${TEST_REPO_ID}::G:\git\example`
const SLASH_ID = `${TEST_REPO_ID}::G:/git/example`
const TAB_ID = 'host-tab'
const PTY_ID = 'persisted-pty'

function savedWindowsSession() {
  return makeWorkspaceSessionWithHeadlessTerminal({
    activeWorktreeId: STORED_ID,
    activeTabIdByWorktree: { [STORED_ID]: TAB_ID },
    tabsByWorktree: {
      [STORED_ID]: [
        {
          id: TAB_ID,
          ptyId: PTY_ID,
          worktreeId: STORED_ID,
          title: 'Persisted Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: PTY_ID })
    }
  })
}

function headlessRuntime() {
  const gitWorktrees = [
    {
      path: String.raw`G:\git\example`,
      head: 'abc',
      branch: 'feature/example',
      isBare: false,
      isMainWorktree: false
    }
  ]
  for (const list of [listWorktrees, listWorktreesSharedStrict, listWorktreesStrict]) {
    vi.mocked(list).mockResolvedValue(gitWorktrees)
  }
  const harness = makeRuntimeStoreWithWorkspaceSession(savedWindowsSession())
  const kill = vi.fn(() => true)
  const runtime = new OrcaRuntimeService(harness.runtimeStore)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'spawned-pty' }),
    write: () => true,
    kill,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, kill, ...harness }
}

describe('mutating session tabs through a forward-slash Windows worktree id', () => {
  it('activates a saved tab and answers with the stored spelling', async () => {
    const { runtime } = headlessRuntime()

    const result = await runtime.activateMobileSessionTab(
      `id:${SLASH_ID}`,
      `${TAB_ID}::${HEADLESS_LEAF_ID}`
    )

    expect(result.worktree).toBe(STORED_ID)
    expect(result.activeTabId).toBe(`${TAB_ID}::${HEADLESS_LEAF_ID}`)
  })

  it('closes a saved tab from the stored spelling', async () => {
    const { runtime, getSession } = headlessRuntime()

    await runtime.closeMobileSessionTab(`id:${SLASH_ID}`, TAB_ID, { reason: 'user' })

    expect(getSession().tabsByWorktree[STORED_ID]).toEqual([])
    expect((await runtime.listMobileSessionTabs(`id:${STORED_ID}`)).tabs).toEqual([])
  })

  it('selects a created terminal for the caller under the stored spelling', async () => {
    const { runtime } = headlessRuntime()
    const alias = await runtime.listMobileSessionTabs(`id:${SLASH_ID}`)
    expect(alias.activeTabId).toBe(`${TAB_ID}::${HEADLESS_LEAF_ID}`)

    const created = await runtime.createMobileSessionTerminal(`id:${SLASH_ID}`, {
      select: true,
      navigation: 'caller',
      clientNavigationId: 'device-a'
    })

    const callerView = await runtime.listMobileSessionTabs(`id:${STORED_ID}`, 'device-a')
    const sharedView = await runtime.listMobileSessionTabs(`id:${STORED_ID}`)
    expect(callerView.tabs.map((tab) => tab.id)).toContain(created.tab.id)
    expect(callerView.activeTabId).toBe(created.tab.id)
    expect(sharedView.activeTabId).toBe(`${TAB_ID}::${HEADLESS_LEAF_ID}`)
  })
})
