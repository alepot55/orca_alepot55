import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { createTestStore } from './store-test-helpers'

describe('consumeCodexRateLimitResetCredit', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hands the redeem outcome back so the status bar can report it', async () => {
    const state = createEmptyRateLimitState()
    vi.stubGlobal('window', {
      api: {
        rateLimits: {
          consumeCodexResetCredit: vi.fn(async () => ({ outcome: 'noCredit', state }))
        }
      }
    })
    const store = createTestStore()

    await expect(store.getState().consumeCodexRateLimitResetCredit()).resolves.toBe('noCredit')
    expect(store.getState().rateLimits).toBe(state)
  })
})
