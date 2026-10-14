// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../../i18n/i18n'
import FeatureTipsModal from './FeatureTipsModal'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store', () => {
  const state = {
    activeModal: 'feature-tips',
    modalData: { tipId: 'orca-cli' },
    settings: null,
    featureTipsSeenIds: [],
    featureInteractions: {},
    nativeChatUpgradeTipVariant: null,
    closeModal: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    updateSettings: vi.fn(),
    markFeatureTipsSeen: vi.fn(),
    showAiVaultSearch: vi.fn()
  }
  return { useAppStore: (select: (s: typeof state) => unknown) => select(state) }
})
vi.mock('./feature-tip-telemetry', () => ({
  getOrcaCliFeatureTipTelemetrySource: () => 'unknown',
  trackCmdJPaletteFeatureTipAcknowledged: vi.fn(),
  trackOrcaCliFeatureTipSetupClicked: vi.fn(),
  trackOrcaCliFeatureTipSetupResult: vi.fn()
}))
vi.mock('./use-session-search-tip-setup', () => ({
  useSessionSearchTipSetup: () => ({ stage: 'offer', status: null, enable: vi.fn() })
}))
vi.mock('./CliSetupTipDialog', () => ({
  CliSetupTipDialog: ({ onPrimaryAction }: { onPrimaryAction: () => void }) => (
    <button onClick={onPrimaryAction}>Set up</button>
  )
}))
vi.mock('./CmdJPaletteTipDialog', () => ({ CmdJPaletteTipDialog: () => null }))
vi.mock('./NativeChatUpgradeTipDialog', () => ({ NativeChatUpgradeTipDialog: () => null }))
vi.mock('./SessionSearchTipDialog', () => ({ SessionSearchTipDialog: () => null }))
vi.mock('./VoiceDictationTipDialog', () => ({ VoiceDictationTipDialog: () => null }))

async function failInstallWithoutMessage(): Promise<void> {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { cli: { install: vi.fn(() => Promise.reject('install crashed')) } }
  })
  render(<FeatureTipsModal />)
  fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
  await waitFor(() => expect(toastError).toHaveBeenCalledOnce())
}

beforeEach(() => {
  toastError.mockClear()
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('FeatureTipsModal CLI install failure', () => {
  it('keeps the English fallback message', async () => {
    await failInstallWithoutMessage()

    expect(toastError).toHaveBeenCalledWith('Failed to install Orca CLI.')
  })

  it('shows the fallback message in the selected UI language', async () => {
    await i18n.changeLanguage('es')
    await failInstallWithoutMessage()

    expect(toastError).toHaveBeenCalledWith('No se pudo instalar Orca CLI.')
  })
})
