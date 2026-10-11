import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'
import {
  SLASH_ID,
  STORED_ID,
  createRuntime,
  publishStoredWorktree
} from '../../session-tabs-windows-worktree-id.test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

type Frame = { ok: boolean; result?: { type?: string; worktree?: string } }

async function subscribe(worktree: string) {
  const runtime = createRuntime()
  publishStoredWorktree(runtime)
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const frames: Frame[] = []
  await dispatcher.dispatchStreaming(
    { id: 'sub-1', authToken: 'token', method: 'session.tabs.subscribe', params: { worktree } },
    (message) => frames.push(JSON.parse(message)),
    { connectionId: 'conn-1' }
  )
  return { runtime, dispatcher, frames }
}

const frameTypes = (frames: Frame[]): (string | undefined)[] =>
  frames.map((frame) => frame.result?.type)

describe('session.tabs.subscribe and unsubscribe across worktree id spellings', () => {
  it.each([
    { spelling: 'exact', id: STORED_ID },
    { spelling: 'forward-slash alias', id: SLASH_ID }
  ])('ends a $spelling subscription when unsubscribed by subscription id', async ({ id }) => {
    const { dispatcher, frames } = await subscribe(`id:${id}`)
    expect(frames[0]?.result).toMatchObject({ type: 'snapshot', worktree: STORED_ID })

    await dispatcher.dispatchStreaming(
      {
        id: 'unsub-1',
        authToken: 'token',
        method: 'session.tabs.unsubscribe',
        params: { worktree: `id:${id}`, subscriptionId: 'sub-1' }
      },
      vi.fn(),
      { connectionId: 'conn-1' }
    )

    expect(frameTypes(frames)).toEqual(['snapshot', 'end'])
  })

  it.each([
    { spelling: 'exact', id: STORED_ID },
    { spelling: 'forward-slash alias', id: SLASH_ID }
  ])(
    'ends a $spelling subscription when unsubscribed without a subscription id',
    async ({ id }) => {
      const { dispatcher, frames } = await subscribe(`id:${id}`)

      await dispatcher.dispatchStreaming(
        {
          id: 'unsub-1',
          authToken: 'token',
          method: 'session.tabs.unsubscribe',
          params: { worktree: `id:${id}` }
        },
        vi.fn(),
        { connectionId: 'conn-1' }
      )

      expect(frameTypes(frames)).toEqual(['snapshot', 'end'])
    }
  )

  it('keeps the stream of another connection when an alias unsubscribe arrives', async () => {
    const { dispatcher, frames } = await subscribe(`id:${SLASH_ID}`)

    await dispatcher.dispatchStreaming(
      {
        id: 'unsub-1',
        authToken: 'token',
        method: 'session.tabs.unsubscribe',
        params: { worktree: `id:${SLASH_ID}`, subscriptionId: 'sub-1' }
      },
      vi.fn(),
      { connectionId: 'conn-2' }
    )

    expect(frameTypes(frames)).toEqual(['snapshot'])
  })
})
