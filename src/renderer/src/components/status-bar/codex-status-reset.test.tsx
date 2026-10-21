// @vitest-environment happy-dom
/**
 * Issue 26786: "Reset now" in the status-bar Codex menu spent a reset credit
 * (or failed to) and reported nothing, so a click looked like it did nothing.
 * These click the real menu item and assert the user sees a message per outcome.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type {
  CodexRateLimitResetOutcome,
  ProviderRateLimits
} from '../../../../shared/rate-limit-types'

const toastSuccess = vi.fn()
const toastInfo = vi.fn()
const toastError = vi.fn()
const consumeCodexRateLimitResetCredit = vi.fn<() => Promise<CodexRateLimitResetOutcome>>()

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, info: toastInfo, error: toastError }
}))

vi.mock('@/lib/codex-session-restart', () => ({
  markLiveCodexSessionsForRestart: vi.fn(async () => {}),
  resolveCodexRestartPromptAccountLabel: () => 'System default'
}))

vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: vi.fn(async () => ({
    codex: { accounts: [], activeAccountId: null },
    claude: { accounts: [], activeAccountId: null },
    failedProviders: []
  })),
  selectCodexProviderAccount: vi.fn(),
  selectClaudeProviderAccount: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({}))

vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: () => ({ wslDistros: [], isLoading: false }),
  getWindowsTerminalCapabilityOwnerKey: () => 'local'
}))

vi.mock('./tooltip', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ProviderIcon: () => null,
  ProviderPanel: () => null
}))

// Why: Radix portals its menu behind pointer-capture the DOM shim cannot drive;
// passthrough shells render the same tree eagerly so the real handlers run.
vi.mock('@/components/ui/dropdown-menu', () => {
  const passthrough =
    (role?: string) =>
    ({
      children,
      onSelect
    }: {
      children?: React.ReactNode
      onSelect?: (event: { preventDefault: () => void }) => void
    }): React.JSX.Element =>
      React.createElement(
        'div',
        {
          role,
          onClick: onSelect ? () => onSelect({ preventDefault: () => {} }) : undefined
        },
        children
      )
  return {
    DropdownMenu: passthrough(),
    DropdownMenuCheckboxItem: passthrough(),
    DropdownMenuContent: passthrough(),
    DropdownMenuItem: passthrough('menuitem'),
    DropdownMenuLabel: passthrough(),
    DropdownMenuSeparator: passthrough(),
    DropdownMenuSub: passthrough(),
    DropdownMenuSubContent: passthrough(),
    DropdownMenuSubTrigger: passthrough(),
    DropdownMenuTrigger: passthrough()
  }
})

vi.mock('../../store', () => {
  const state = (): Record<string, unknown> => ({
    settings: { ...getDefaultSettings('/tmp'), skipCodexRateLimitResetConfirm: true },
    runtimeEnvironments: [],
    usagePercentageDisplay: 'used',
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    fetchSettings: vi.fn(),
    updateSettings: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    refreshCodexRateLimitsForTarget: vi.fn(),
    consumeCodexRateLimitResetCredit,
    fetchInactiveCodexAccountUsage: vi.fn(),
    rateLimits: {
      inactiveCodexAccounts: [],
      codexTarget: { runtime: 'host', wslDistro: null }
    }
  })
  const useAppStore = (selector: (value: Record<string, unknown>) => unknown): unknown =>
    selector(state())
  useAppStore.getState = state
  return { useAppStore }
})

const codexWithResetCredit: ProviderRateLimits = {
  provider: 'codex',
  session: null,
  weekly: null,
  status: 'ok',
  error: null,
  updatedAt: 1,
  rateLimitResetCredits: { availableCount: 1, nextExpiresAt: null }
}

async function clickResetNow(): Promise<void> {
  const { CodexSwitcherMenu } = await import('./StatusBar')
  render(
    React.createElement(CodexSwitcherMenu, {
      codex: codexWithResetCredit,
      compact: false,
      iconOnly: false
    })
  )
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reset now' }))
  await waitFor(() => expect(consumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(1))
}

describe('status bar Codex "Reset now" feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('confirms a successful reset', async () => {
    consumeCodexRateLimitResetCredit.mockResolvedValue('reset')

    await clickResetNow()

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Codex limits reset'))
    expect(toastInfo).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it.each([
    ['nothingToReset', 'No eligible Codex rate-limit window to reset.'],
    ['noCredit', 'No Codex rate-limit reset is available.']
  ] as const)('explains the %s no-op instead of staying silent', async (outcome, message) => {
    consumeCodexRateLimitResetCredit.mockResolvedValue(outcome)

    await clickResetNow()

    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith(message))
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  // A retried click reuses the idempotency key, so this means the earlier request already reset the limits.
  it('reports alreadyRedeemed as a reset that was already applied, not a spent credit', async () => {
    consumeCodexRateLimitResetCredit.mockResolvedValue('alreadyRedeemed')

    await clickResetNow()

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Codex reset already applied'))
    expect(toastInfo).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('reports a failed reset instead of only logging it', async () => {
    consumeCodexRateLimitResetCredit.mockRejectedValue(new Error('Codex reset failed: HTTP 502'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await clickResetNow()

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't reset Codex limits. Please try again.")
    )
    expect(toastSuccess).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
