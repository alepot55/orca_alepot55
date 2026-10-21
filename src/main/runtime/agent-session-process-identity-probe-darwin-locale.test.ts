import { afterEach, expect, it, vi } from 'vitest'
import { emulateDarwinPsLocale } from '../../shared/process-table-ps-test-fixture'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

const { readProcessStartTimeMs, readProcessStartTimesMs } =
  await import('./agent-session-process-identity-probe')

afterEach(() => {
  vi.unstubAllEnvs()
  runProcess.mockReset()
})

it.each(['de_DE.UTF-8', 'pl_PL.UTF-8'])(
  'reads macOS owner start times when Orca runs under LC_ALL=%s',
  async (locale) => {
    vi.stubEnv('LC_ALL', locale)
    runProcess.mockImplementation(
      async (spec: { args: readonly string[]; env?: NodeJS.ProcessEnv }) => {
        const { lstart } = emulateDarwinPsLocale(spec.env ?? process.env, '')
        const pidColumn = spec.args.includes('pid=,lstart=') ? '4242 ' : ''
        return { code: 0, signal: null, stdout: `${pidColumn}${lstart}\n`, timedOut: false }
      }
    )

    const startedAtMs = Date.parse('Sat Oct 10 00:04:51 2026')
    await expect(readProcessStartTimeMs(4242, 'darwin')).resolves.toBe(startedAtMs)
    await expect(readProcessStartTimesMs([4242], 'darwin')).resolves.toEqual(
      new Map([[4242, startedAtMs]])
    )
  }
)
