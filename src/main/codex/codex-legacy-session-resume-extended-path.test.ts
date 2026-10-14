import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodePath from 'node:path'
import {
  prepareCodexAccountRestartResume,
  prepareLegacySharedCodexSessionResume
} from './codex-legacy-session-resume'

// Why win32 paths on every host: Codex on Windows records transcripts as \\?\C:\..., which only win32 path semantics reproduce.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof NodePath>('node:path')
  return { ...actual.win32, default: actual.win32 }
})

const fakeFs = vi.hoisted(() => {
  const links: { source: string; target: string }[] = []
  return {
    existing: new Set<string>(),
    links,
    // Either spelling of a drive path reaches the same file on Windows.
    fold: (filePath: string): string => filePath.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '')
  }
})

vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(async (target: string) => {
    if (!fakeFs.existing.has(fakeFs.fold(target))) {
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
    }
    return { isFile: () => true, isSymbolicLink: () => false }
  }),
  mkdir: vi.fn(async () => undefined),
  link: vi.fn(async (source: string, target: string) => {
    fakeFs.links.push({ source: fakeFs.fold(source), target })
  })
}))
vi.mock('./codex-session-backfill', () => ({
  resolveCodexSessionBackfillPaths: (systemHome: string) => ({
    managedSessionsRoot:
      'C:\\Users\\Example\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\sessions',
    systemSessionsRoot: `${systemHome}\\sessions`,
    auditLogPath: 'C:\\Users\\Example\\AppData\\Roaming\\orca\\audit.jsonl',
    markerPath: 'C:\\Users\\Example\\AppData\\Roaming\\orca\\marker.json'
  })
}))
vi.mock('./codex-session-backfill-audit', () => ({
  createCodexSessionBackfillAuditWriter: vi.fn(),
  appendCodexSessionHealAuditRecord: vi.fn(async () => true)
}))
vi.mock('./codex-session-backfill-copy', () => ({
  copySessionFileWithoutOverwrite: vi.fn(),
  isAtomicNoReplaceUnsupportedError: () => false
}))

const SHARED_HOME = 'C:\\Users\\Example\\AppData\\Roaming\\orca\\codex-runtime-home\\home'
const SYSTEM_HOME = 'C:\\Users\\Example\\.codex'
const ACCOUNTS_ROOT = 'C:\\Users\\Example\\AppData\\Roaming\\orca\\codex-accounts'
const PEER_HOME = `${ACCOUNTS_ROOT}\\11111111-aaaa-4aaa-8aaa-111111111111\\home`
const SELECTED_HOME = `${ACCOUNTS_ROOT}\\99999999-bbbb-4bbb-8bbb-999999999999\\home`
const ROLLOUT_TAIL = 'sessions\\2026\\10\\01\\rollout-2026-10-01T09-00-00-example.jsonl'

const options = (overrides: Record<string, unknown> = {}) => ({
  isHostSystemDefaultRealHomeSelected: () => true,
  legacyCodexHomePath: SHARED_HOME,
  systemCodexHomePath: SYSTEM_HOME,
  ...overrides
})

const legacyArgs = (filePath: string, codexHome = SHARED_HOME) => ({
  agent: 'codex' as const,
  filePath,
  codexHome,
  executionHostId: 'local' as const
})

beforeEach(() => {
  fakeFs.existing.clear()
  fakeFs.links.length = 0
  fakeFs.existing.add(`${SHARED_HOME}\\${ROLLOUT_TAIL}`)
  fakeFs.existing.add(`${PEER_HOME}\\${ROLLOUT_TAIL}`)
  fakeFs.existing.add(`${SELECTED_HOME}\\${ROLLOUT_TAIL}`)
})

describe('Windows extended-length transcript paths', () => {
  it.each([
    ['ordinary', `${SHARED_HOME}\\${ROLLOUT_TAIL}`],
    ['extended-length', `\\\\?\\${SHARED_HOME}\\${ROLLOUT_TAIL}`]
  ])('moves a %s legacy transcript into the system Codex home', async (_label, filePath) => {
    await expect(
      prepareLegacySharedCodexSessionResume(legacyArgs(filePath), options())
    ).resolves.toEqual({ useRealCodexHome: true })

    expect(fakeFs.links).toEqual([
      {
        source: `${SHARED_HOME}\\${ROLLOUT_TAIL}`,
        target: `${SYSTEM_HOME}\\${ROLLOUT_TAIL}`
      }
    ])
  })

  it.each([
    ['network share', `\\\\?\\UNC\\server\\share\\${ROLLOUT_TAIL}`],
    ['device namespace', `\\\\.\\${SHARED_HOME}\\${ROLLOUT_TAIL}`],
    ['volume GUID', `\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\${ROLLOUT_TAIL}`],
    ['dot-dot escape', `\\\\?\\${SHARED_HOME}\\sessions\\2026\\10\\01\\..\\rollout-a.jsonl`],
    ['outside the dated layout', `\\\\?\\${SHARED_HOME}\\sessions\\stray.jsonl`],
    ['another home', `\\\\?\\${PEER_HOME}\\${ROLLOUT_TAIL}`]
  ])('still refuses an extended-length path in a %s', async (_label, filePath) => {
    await expect(
      prepareLegacySharedCodexSessionResume(legacyArgs(filePath), options())
    ).rejects.toThrow(/Retry resume/)

    expect(fakeFs.links).toEqual([])
  })

  it('keeps the legacy home when a non-default Codex home is selected', async () => {
    await expect(
      prepareLegacySharedCodexSessionResume(
        legacyArgs(`\\\\?\\${SHARED_HOME}\\${ROLLOUT_TAIL}`),
        options({ isHostSystemDefaultRealHomeSelected: () => false })
      )
    ).resolves.toEqual({ useRealCodexHome: false })

    expect(fakeFs.links).toEqual([])
  })

  it('repins an extended-length transcript to the selected account home', async () => {
    await expect(
      prepareLegacySharedCodexSessionResume(
        legacyArgs(`\\\\?\\${PEER_HOME}\\${ROLLOUT_TAIL}`, PEER_HOME),
        options({
          isHostSystemDefaultRealHomeSelected: () => false,
          getSelectedHostAccountCodexHomePath: () => SELECTED_HOME
        })
      )
    ).resolves.toEqual({ useRealCodexHome: false, substituteCodexHome: SELECTED_HOME })
  })

  it('moves an extended-length transcript into the account an explicit restart selects', async () => {
    await expect(
      prepareCodexAccountRestartResume({
        sourceHome: SHARED_HOME,
        transcriptPath: `\\\\?\\${SHARED_HOME}\\${ROLLOUT_TAIL}`,
        targetHome: SELECTED_HOME,
        systemCodexHomePath: SYSTEM_HOME
      })
    ).resolves.toBe(SELECTED_HOME)

    expect(fakeFs.links).toEqual([
      {
        source: `${SHARED_HOME}\\${ROLLOUT_TAIL}`,
        target: `${SELECTED_HOME}\\${ROLLOUT_TAIL}`
      }
    ])
  })
})
