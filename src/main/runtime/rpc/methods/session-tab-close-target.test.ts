import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TAB_METHODS } from './session-tabs'
import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function splitPaneSnapshot() {
  const snapshot = visibleSnapshot()
  const [left] = snapshot.tabs
  return {
    ...snapshot,
    tabs: [
      left,
      { ...left, id: 'tab-1::leaf-2', leafId: 'leaf-2', terminal: 'pty-2', isActive: false },
      {
        type: 'markdown' as const,
        id: 'markdown-1',
        title: 'Notes',
        filePath: '/repo/notes.md',
        relativePath: 'notes.md',
        language: 'markdown' as const,
        mode: 'edit' as const,
        isDirty: false,
        isActive: false,
        sourceFileId: 'file-1',
        sourceFilePath: '/repo/notes.md',
        sourceRelativePath: 'notes.md',
        documentVersion: 'v1'
      }
    ]
  }
}

function makeSplitPaneDispatcher() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only these runtime methods for session.tabs.close.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    listMobileSessionTabs: vi.fn().mockResolvedValue(splitPaneSnapshot()),
    refuseUnattributedMobileSessionTabClose: vi.fn(),
    closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
  } as unknown as OrcaRuntimeService
  return { runtime, dispatcher: new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS }) }
}

describe('session.tabs.close addressed by tab id and leaf id', () => {
  it('closes only the named pane when the tab id names the parent', async () => {
    const { runtime, dispatcher } = makeSplitPaneDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.close', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        leafId: 'leaf-2',
        reason: 'user'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledTimes(1)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1::leaf-2', {
      reason: 'user'
    })
  })

  it('accepts a pane tab id that agrees with the leaf id', async () => {
    const { runtime, dispatcher } = makeSplitPaneDispatcher()

    await dispatcher.dispatch(
      makeRequest('session.tabs.close', {
        worktree: 'id:wt-1',
        tabId: 'tab-1::leaf-2',
        leafId: 'leaf-2',
        reason: 'user'
      })
    )

    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1::leaf-2', {
      reason: 'user'
    })
  })

  it.each([
    ['a pane tab id naming another leaf', 'tab-1::leaf-1', 'leaf-2'],
    ['a leaf the tab does not have', 'tab-1', 'leaf-missing'],
    ['an empty leaf id', 'tab-1', ''],
    ['a leaf id sent with a non-terminal tab id', 'markdown-1', 'leaf-1']
  ])('rejects %s without closing anything', async (_label, tabId, leafId) => {
    const { runtime, dispatcher } = makeSplitPaneDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId, leafId, reason: 'user' })
    )

    expect(response.ok).toBe(false)
    expect(JSON.stringify(response)).toContain('tab_not_found')
    expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
  })

  it('refuses a reasonless close of the named pane instead of closing the tab', async () => {
    const { runtime, dispatcher } = makeSplitPaneDispatcher()

    await dispatcher.dispatch(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1', leafId: 'leaf-2' })
    )

    expect(runtime.refuseUnattributedMobileSessionTabClose).toHaveBeenCalledWith(
      'id:wt-1',
      'tab-1::leaf-2'
    )
    expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
  })
})
