import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshRepoReadoption, SshTarget } from '../../../shared/ssh-types'

const { storeState } = vi.hoisted(() => ({
  storeState: {
    recordSshRepoReadoptions: vi.fn(),
    setSshTargetsMetadata: vi.fn()
  }
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

import { syncSshConfigHostsPassively } from './ssh-config-passive-sync'

const importConfig = vi.fn()
const listTargets = vi.fn()
const target: SshTarget = { id: 'target-1', label: 'prod', host: 'prod', port: 22, username: 'dev' }
const readoption: SshRepoReadoption = {
  oldTargetId: 'old-target',
  newTargetId: 'target-1',
  repoIds: ['repo-1']
}

// Why: the throttle is module state; each case must start well after the previous one.
let clock = Date.now()

describe('syncSshConfigHostsPassively', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    clock += 60_000
    vi.setSystemTime(clock)
    importConfig.mockReset().mockResolvedValue({ targets: [], repoReadoptions: [] })
    listTargets.mockReset().mockResolvedValue([target])
    storeState.recordSshRepoReadoptions.mockReset()
    storeState.setSshTargetsMetadata.mockReset()
    vi.stubGlobal('window', { api: { ssh: { importConfig, listTargets } } })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('refreshes the host list when the config sync changed a host', async () => {
    importConfig.mockResolvedValue({ targets: [target], repoReadoptions: [readoption] })

    await syncSshConfigHostsPassively()

    expect(importConfig).toHaveBeenCalledWith()
    expect(storeState.recordSshRepoReadoptions).toHaveBeenCalledWith([readoption])
    expect(storeState.setSshTargetsMetadata).toHaveBeenCalledWith([target])
  })

  it('does not reload the host list when nothing changed', async () => {
    await syncSshConfigHostsPassively()

    expect(importConfig).toHaveBeenCalledTimes(1)
    expect(listTargets).not.toHaveBeenCalled()
    expect(storeState.setSshTargetsMetadata).not.toHaveBeenCalled()
  })

  it('reads the config once per interval, including for overlapping calls', async () => {
    await Promise.all([syncSshConfigHostsPassively(), syncSshConfigHostsPassively()])
    expect(importConfig).toHaveBeenCalledTimes(1)

    vi.setSystemTime(clock + 1_000)
    await syncSshConfigHostsPassively()
    expect(importConfig).toHaveBeenCalledTimes(1)

    vi.setSystemTime(clock + 6_000)
    await syncSshConfigHostsPassively()
    expect(importConfig).toHaveBeenCalledTimes(2)
  })

  it('swallows a failed sync and leaves the host list alone', async () => {
    importConfig.mockRejectedValue(new Error('config unreadable'))

    await expect(syncSshConfigHostsPassively()).resolves.toBeUndefined()

    expect(storeState.setSshTargetsMetadata).not.toHaveBeenCalled()
  })
})
