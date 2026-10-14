import { afterEach, expect, it, vi } from 'vitest'
import {
  emulateDarwinPsLocale,
  emulateProcpsLocale
} from '../../shared/process-table-ps-test-fixture'
import { getPsProcessIdentity, getPsProcessIdentityAsync } from './daemon-process-identity-query'
import { readMacosProcessStartedAtMs, readProcessCommandLine } from './daemon-process-inspection'

const { execFile, execFileSync } = vi.hoisted(() => ({ execFile: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile, execFileSync }))

const DAEMON_ARGV = '/Users/zoë/Orca.app/Contents/MacOS/Orca daemon-entry.js'
const LINUX_DAEMON_ARGV = '/home/zoë/Orca/orca daemon-entry.js'
const LOCALE_VARIABLES = ['LANG', 'LC_ALL', 'LC_COLLATE', 'LC_CTYPE', 'LC_MESSAGES', 'LC_TIME']
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

function stubLocale(locale: Record<string, string>): void {
  for (const name of LOCALE_VARIABLES) {
    vi.stubEnv(name, locale[name])
  }
}

function macPs(options: { env?: NodeJS.ProcessEnv } | undefined): string {
  const { lstart, command } = emulateDarwinPsLocale(options?.env ?? process.env, DAEMON_ARGV)
  return `${lstart} ${command}\n`
}

it.each(['de_DE.UTF-8', 'ja_JP.UTF-8'])(
  'reads a macOS daemon identity when Orca runs under LC_ALL=%s',
  async (locale) => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    vi.stubEnv('LC_ALL', locale)
    execFileSync.mockImplementation((_file, _args, options) => macPs(options))
    execFile.mockImplementation((_file, _args, options, callback) => callback(null, macPs(options)))

    const expected = {
      startedAtMs: Date.parse('Sat Oct 10 00:04:51 2026'),
      commandLine: DAEMON_ARGV
    }
    expect(getPsProcessIdentity(42)).toEqual(expected)
    await expect(getPsProcessIdentityAsync(42)).resolves.toEqual(expected)
  }
)

it.each<Record<string, string>>([
  { LC_ALL: 'de_DE.UTF-8' },
  { LANG: 'pl_PL.UTF-8' },
  // Dock launch: no locale at all.
  {}
])('probes a macOS daemon incarnation under %o', async (locale) => {
  stubLocale(locale)
  execFile.mockImplementation((_file, args: string[], options, callback) => {
    const { lstart, command } = emulateDarwinPsLocale(options?.env ?? process.env, DAEMON_ARGV)
    callback(null, { stdout: `${args.includes('lstart=') ? lstart : command}\n`, stderr: '' })
  })

  await expect(readProcessCommandLine(42, 'darwin')).resolves.toBe(DAEMON_ARGV)
  await expect(readMacosProcessStartedAtMs(42)).resolves.toBe(
    Date.parse('Sat Oct 10 00:04:51 2026')
  )
})

it.each<Record<string, string>>([
  { LANG: 'de_DE.UTF-8' },
  { LC_ALL: 'de_DE.UTF-8' },
  // LC_ALL overrode this LC_CTYPE, so argv stayed UTF-8 and must still.
  { LC_ALL: 'de_DE.UTF-8', LC_CTYPE: 'C' },
  { LANG: 'en_US.UTF-8', LC_TIME: 'de_DE.UTF-8' }
])('reads a Linux daemon identity from procps-ng under %o', async (locale) => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  stubLocale(locale)
  const linuxPs = (options: { env?: NodeJS.ProcessEnv } | undefined): string => {
    const { lstart, command } = emulateProcpsLocale(options?.env ?? process.env, LINUX_DAEMON_ARGV)
    return `${lstart} ${command}\n`
  }
  execFileSync.mockImplementation((_file, _args, options) => linuxPs(options))
  execFile.mockImplementation((_file, _args, options, callback) => callback(null, linuxPs(options)))

  const expected = {
    startedAtMs: Date.parse('Fri Oct  9 22:08:59 2026'),
    commandLine: LINUX_DAEMON_ARGV
  }
  expect(getPsProcessIdentity(42)).toEqual(expected)
  await expect(getPsProcessIdentityAsync(42)).resolves.toEqual(expected)
})
