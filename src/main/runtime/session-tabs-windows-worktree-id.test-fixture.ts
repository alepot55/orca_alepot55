import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

// One Windows workspace the host stores with backslashes; clients may spell it with forward slashes.
export const STORED_ID = String.raw`repo-id::G:\git\example`
export const SLASH_ID = 'repo-id::G:/git/example'
export const TAB_ID = 'tab-1'
export const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const PTY_ID = 'pty-1'

export function publishStoredWorktree(runtime: OrcaRuntimeService, worktreeId = STORED_ID): void {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [{ tabId: TAB_ID, worktreeId, title: 'Terminal', activeLeafId: LEAF_ID, layout: null }],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: 'pwsh'
      }
    ],
    mobileSessionTabs: [
      {
        worktree: worktreeId,
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: `${TAB_ID}::${LEAF_ID}`,
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: `${TAB_ID}::${LEAF_ID}`,
            parentTabId: TAB_ID,
            leafId: LEAF_ID,
            ptyId: PTY_ID,
            title: 'pwsh',
            isActive: true
          }
        ]
      }
    ]
  })
}

export function createRuntime(store?: SavedSessionStoreStub): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stubs implement only the store reads these tests make.
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return runtime
}

export type SavedSessionStoreStub = ReturnType<typeof storeSavingOnly>

/** A store whose saved session holds one terminal tab under only the given spelling. */
export function storeSavingOnly(worktreeId: string, registeredWorktreeId?: string) {
  const repo = { id: 'repo-id', path: String.raw`G:\git\example` }
  return {
    getRepo: (id: string) => (id === repo.id ? repo : undefined),
    getRepos: () => [repo],
    getWorktreeMeta: (id: string) =>
      id === registeredWorktreeId ? { displayName: id } : undefined,
    getAllWorktreeMeta: () => ({}),
    getWorkspaceSession: () => ({
      activeRepoId: null,
      activeWorktreeId: worktreeId,
      activeTabId: TAB_ID,
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: TAB_ID,
            ptyId: null,
            worktreeId,
            title: 'Terminal 1',
            defaultTitle: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })
  }
}
