// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_WALL_WORKFLOWS } from '../../../../shared/feature-wall-workflows'
import { i18n } from '../../i18n/i18n'
import { FeatureWallTourSurface } from './FeatureWallTourSurface'

vi.mock('@/store', () => {
  const state = { settings: null, updateSettings: vi.fn() }
  return { useAppStore: (select: (s: typeof state) => unknown) => select(state) }
})
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ discoveryTarget: null })
}))
vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: [],
  useInstalledAgentSkill: () => ({ installed: false })
}))
vi.mock('./feature-wall-assets', () => ({
  toFeatureWallAssetUrl: () => null,
  useFeatureWallAssetBaseUrl: () => null
}))
vi.mock('./use-feature-wall-task-source-presentation', () => ({
  useFeatureWallTaskSourcePresentation: () => ({
    workflow: FEATURE_WALL_WORKFLOWS[0],
    hasConnectedTaskSource: false,
    isCheckingTaskSources: false
  })
}))
vi.mock('./use-feature-wall-completion', () => ({
  useFeatureWallCompletion: () => ({
    markWorkflowVisited: vi.fn(),
    markAgentStepVisited: vi.fn(),
    markWorkbenchStepVisited: vi.fn(),
    markReviewStepVisited: vi.fn(),
    getTourDepthSummary: vi.fn()
  })
}))
vi.mock('./use-feature-wall-tour-telemetry', () => ({
  useFeatureWallTourTelemetry: () => ({ markExitAction: vi.fn() })
}))
vi.mock('./FeatureWallTourPanel', () => ({
  FeatureWallTourPanel: ({ footerText }: { footerText: string | null }) => (
    <footer>{footerText}</footer>
  )
}))

function renderSurface(footerText?: string | null): void {
  render(
    <FeatureWallTourSurface isOpen source="help_menu" onDone={() => {}} footerText={footerText} />
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('FeatureWallTourSurface footer', () => {
  it('keeps the English reopen hint by default', () => {
    renderSurface()

    expect(screen.getByRole('contentinfo').textContent).toBe(
      'Reopen any time from Help > Explore Orca.'
    )
  })

  it('shows the reopen hint in the selected UI language with the localized menu names', async () => {
    await i18n.changeLanguage('es')
    renderSurface()

    expect(screen.getByRole('contentinfo').textContent).toBe(
      'Vuelve a abrirlo cuando quieras desde Ayuda > Explorar Orca.'
    )
  })

  it('honors an explicit footer override', () => {
    renderSurface('Custom hint')

    expect(screen.getByRole('contentinfo').textContent).toBe('Custom hint')
  })
})
