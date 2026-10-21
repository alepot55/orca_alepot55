// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'
import { i18n } from '../../i18n/i18n'
import { CrashReportDialogSurface } from './CrashReportDialogSurface'

const viewer = vi.fn(async () => null)

vi.mock('./use-crash-report-copy', () => ({
  useCrashReportCopy: () => vi.fn(async () => {})
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>
}))

function crashReport(overrides: Partial<CrashReportRecord>): CrashReportRecord {
  return {
    id: 'crash-1',
    createdAt: '2026-08-10T00:00:00.000Z',
    status: 'pending',
    source: 'child',
    processType: 'browser',
    reason: 'crashed',
    exitCode: 5,
    appVersion: '1.0.0',
    platform: 'darwin',
    osRelease: 'test',
    arch: 'arm64',
    electronVersion: '41',
    chromeVersion: '141',
    details: {},
    ...overrides
  }
}

const rendererErrorReport = crashReport({
  source: 'renderer',
  processType: 'react-render',
  reason: 'react-error-boundary'
})

async function renderDialog(report: CrashReportRecord | null): Promise<void> {
  render(
    <CrashReportDialogSurface
      open
      report={report}
      loading={false}
      onOpenChange={() => {}}
      onReportChange={() => {}}
    />
  )
  await waitFor(() => expect(viewer).toHaveBeenCalledOnce())
}

beforeEach(() => {
  viewer.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gh: { viewer } }
  })
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('CrashReportDialogSurface localization', () => {
  it('keeps the English copy for an unexpected close', async () => {
    await renderDialog(crashReport({}))

    expect(screen.getByRole('heading').textContent).toBe('Orca closed unexpectedly')
    expect(
      screen.getByText('Send a privacy-safe diagnostic report to help us understand what happened.')
    ).toBeTruthy()
    expect(
      screen.getByPlaceholderText('Optional: what were you doing before Orca closed?')
    ).toBeTruthy()
  })

  it('shows the unexpected-close dialog in the selected UI language', async () => {
    await i18n.changeLanguage('es')
    await renderDialog(crashReport({}))

    expect(screen.getByRole('heading').textContent).toBe('Orca se cerró inesperadamente')
    expect(screen.getByText(/^Envía un informe de diagnóstico/)).toBeTruthy()
    expect(
      screen.getByPlaceholderText(/^Opcional: ¿qué estabas haciendo antes de que Orca/)
    ).toBeTruthy()
  })

  it('shows the recoverable UI error dialog in the selected UI language', async () => {
    await i18n.changeLanguage('es')
    await renderDialog(rendererErrorReport)

    expect(screen.getByRole('heading').textContent).toBe(
      'Orca encontró un error de interfaz recuperable'
    )
    expect(screen.getByText(/^Envía un informe de diagnóstico/)).toBeTruthy()
    expect(
      screen.getByPlaceholderText(/^Opcional: ¿qué estabas haciendo antes de este error/)
    ).toBeTruthy()
  })

  it('shows the manual crash report dialog in the selected UI language', async () => {
    await i18n.changeLanguage('es')
    await renderDialog(null)

    expect(screen.getByRole('heading').textContent).toBe('Informar de un fallo')
    expect(screen.getByText(/^Envía un informe de fallo/)).toBeTruthy()
    expect(screen.getByPlaceholderText('Opcional: ¿qué pasó?')).toBeTruthy()
  })
})
