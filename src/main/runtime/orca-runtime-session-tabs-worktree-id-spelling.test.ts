import { describe, expect, it, vi } from 'vitest'
import {
  LEAF_ID,
  PTY_ID,
  SLASH_ID,
  STORED_ID,
  TAB_ID,
  createRuntime,
  publishStoredWorktree,
  storeSavingOnly
} from './session-tabs-windows-worktree-id.test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('listing session tabs for a Windows worktree id spelled with forward slashes', () => {
  it('lists the tabs the host stored under the backslash spelling', async () => {
    const runtime = createRuntime()
    publishStoredWorktree(runtime)

    const exact = await runtime.listMobileSessionTabs(`id:${STORED_ID}`)
    const alias = await runtime.listMobileSessionTabs(`id:${SLASH_ID}`)

    expect(exact.tabs).toHaveLength(1)
    expect(alias.tabs.map((tab) => tab.id)).toEqual(exact.tabs.map((tab) => tab.id))
    expect(alias.worktree).toBe(STORED_ID)
  })

  it('keeps the requested spelling when the host stores nothing for that worktree', async () => {
    const runtime = createRuntime()
    publishStoredWorktree(runtime)

    const unknown = await runtime.listMobileSessionTabs(String.raw`id:repo-id::G:/git/other`)

    expect(unknown.tabs).toEqual([])
    expect(unknown.worktree).toBe('repo-id::G:/git/other')
  })

  it('does not merge a different repo that shares the path', async () => {
    const runtime = createRuntime()
    publishStoredWorktree(runtime)

    const otherRepo = await runtime.listMobileSessionTabs('id:other-repo::G:/git/example')

    expect(otherRepo.tabs).toEqual([])
  })

  it('hydrates saved tabs stored under the backslash spelling', async () => {
    const runtime = createRuntime(storeSavingOnly(STORED_ID))

    const alias = await runtime.listMobileSessionTabs(`id:${SLASH_ID}`)

    expect(alias.worktree).toBe(STORED_ID)
    expect(alias.tabs.map((tab) => tab.type)).toEqual(['terminal'])
  })
})

describe('an exact worktree id the host already tracks', () => {
  it('keeps its live terminals when only another spelling is saved', async () => {
    const runtime = createRuntime(storeSavingOnly(SLASH_ID))
    publishStoredWorktree(runtime)
    // Leave live leaves and ptys under the exact spelling, with no snapshot or saved session.
    runtime['mobileSessionTabsByWorktree'].delete(STORED_ID)

    const terminals = await runtime.listTerminals(`id:${STORED_ID}`)
    const tabs = await runtime.listMobileSessionTabs(`id:${STORED_ID}`)

    expect(terminals.terminals.map((terminal) => terminal.ptyId)).toEqual([PTY_ID])
    expect(tabs.worktree).toBe(STORED_ID)
  })

  it('keeps its published tabs when only another spelling is saved', async () => {
    const runtime = createRuntime(storeSavingOnly(SLASH_ID))
    publishStoredWorktree(runtime)

    const tabs = await runtime.listMobileSessionTabs(`id:${STORED_ID}`)
    const terminals = await runtime.listTerminals(`id:${STORED_ID}`)

    expect(tabs.tabs.map((tab) => tab.id)).toEqual([`${TAB_ID}::${LEAF_ID}`])
    expect(terminals.terminals.map((terminal) => terminal.ptyId)).toEqual([PTY_ID])
  })

  it('keeps a registered worktree even when only another spelling is saved', async () => {
    const runtime = createRuntime(storeSavingOnly(SLASH_ID, STORED_ID))

    const tabs = await runtime.listMobileSessionTabs(`id:${STORED_ID}`)

    expect(tabs.worktree).toBe(STORED_ID)
    expect(tabs.tabs).toEqual([])
  })
})
