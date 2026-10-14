import { afterEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import * as processTableFormat from './process-table-snapshot'
import {
  getProcessTableSnapshot,
  getStrictProcessTableSnapshot,
  resetProcessTableSnapshotForTests
} from './process-table-snapshot-reader'
import { emulateDarwinPsLocale } from './process-table-ps-test-fixture'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetProcessTableSnapshotForTests()
})

describe('process table parsing on non-Linux hosts', () => {
  it.each(['darwin', 'win32'])('only parses the requested view on %s', async (hostPlatform) => {
    Object.defineProperty(process, 'platform', { value: hostPlatform })
    resetProcessTableSnapshotForTests()
    const lenient = vi.spyOn(processTableFormat, 'parseProcessTableRows')
    const strict = vi.spyOn(processTableFormat, 'parseStrictProcessTableRows')
    execFileMock.mockImplementation((_program, _args, _options, callback) => {
      callback(null, {
        stdout: '100 1 100 100 Ss+ ?? Fri Oct 9 12:34:56 2026 /bin/zsh\n',
        stderr: ''
      })
    })

    expect((await getStrictProcessTableSnapshot())[0]?.pid).toBe(100)
    expect(lenient).not.toHaveBeenCalled()
    expect(strict).toHaveBeenCalledTimes(1)
    await getStrictProcessTableSnapshot()
    expect(strict).toHaveBeenCalledTimes(1)
    expect((await getProcessTableSnapshot())[0]?.pid).toBe(100)
    expect(lenient).toHaveBeenCalledTimes(1)
  })
})

describe('macOS process table under the locale Orca was launched with', () => {
  const AGENT_ARGV = '/opt/homebrew/bin/claude --resume x-ł-日本'
  const LOCALE_VARIABLES = ['LANG', 'LC_ALL', 'LC_COLLATE', 'LC_CTYPE', 'LC_MESSAGES', 'LC_TIME']

  it.each<Record<string, string>>([
    { LANG: 'en_NZ.UTF-8' },
    { LANG: 'de_DE.UTF-8' },
    { LANG: 'ja_JP.UTF-8' },
    { LANG: 'en_US.UTF-8', LC_ALL: 'de_DE.UTF-8' },
    { LANG: 'en_US.UTF-8', LC_TIME: 'en_NZ.UTF-8' },
    // Dock launch: no locale at all.
    {}
  ])('reads the terminal, start time and argv under %o', async (locale) => {
    for (const name of LOCALE_VARIABLES) {
      vi.stubEnv(name, locale[name])
    }
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    resetProcessTableSnapshotForTests()
    execFileMock.mockImplementation((_program, _args, options, callback) => {
      const { lstart, command } = emulateDarwinPsLocale(options?.env ?? process.env, AGENT_ARGV)
      callback(null, { stdout: `50460 50009 50460 0 Ss ?? ${lstart} ${command}\n`, stderr: '' })
    })

    const expected = [
      {
        pid: 50460,
        ppid: 50009,
        pgid: 50460,
        tpgid: 0,
        stat: 'Ss',
        tty: '??',
        startTime: 'Sat Oct 10 00:04:51 2026',
        command: AGENT_ARGV
      }
    ]
    expect(await getStrictProcessTableSnapshot()).toEqual(expected)
    expect(await getProcessTableSnapshot()).toEqual(expected)
  })
})
