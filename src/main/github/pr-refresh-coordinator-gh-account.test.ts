import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(coordinatorMocks))
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))
vi.mock('../ipc/ui', () => moduleMocks.ipcUiModuleMock(coordinatorMocks))

import { makeCandidate } from './pr-refresh-coordinator-test-harness'

const { getPRForBranchOutcomeMock } = coordinatorMocks

const boundAccount = { host: 'github.com', user: 'work-account' }

describe('pr-refresh-coordinator bound GitHub account', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: Date.now() })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('looks up queued refreshes as the project bound account', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')

    enqueuePRRefresh(
      makeCandidate({ localGitOptions: { ghAccount: boundAccount, wslDistro: 'Ubuntu' } }),
      'active',
      80,
      1
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      '/repo',
      'feature/test',
      null,
      null,
      null,
      {
        localGitExecOptions: {
          wslDistro: 'Ubuntu',
          ghAccount: boundAccount,
          admissionTier: 'background'
        }
      }
    )
  })

  it('looks up manual refreshes as the project bound account', async () => {
    const { refreshPRNow } = await import('./pr-refresh-coordinator')

    await refreshPRNow(makeCandidate({ localGitOptions: { ghAccount: boundAccount } }), 'manual')

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      '/repo',
      'feature/test',
      null,
      null,
      null,
      { localGitExecOptions: { ghAccount: boundAccount, admissionTier: 'interactive' } }
    )
  })
})
