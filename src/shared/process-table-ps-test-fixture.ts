import { basename } from 'node:path'
import type { nameDarwinTerminals } from './darwin-terminal-names'

export type PsFixtureRow = {
  pid: number
  ppid: number
  pgid: number
  tpgid: number
  stat: string
  terminalMinor: number
  startTime: string
  startTicks: number
  command: string
}

// macOS `ps -o lstart=` for one instant, as captured per locale in issue #27004.
const DARWIN_LSTART_BY_LOCALE: Record<string, string> = {
  C: 'Sat Oct 10 00:04:51 2026',
  'en_US.UTF-8': 'Sat Oct 10 00:04:51 2026',
  'en_NZ.UTF-8': 'Sat 10 Oct 00:04:51 2026',
  'de_DE.UTF-8': 'Sa. 10 Okt. 00:04:51 2026',
  'ja_JP.UTF-8': '土 10/10 00:04:51 2026',
  'pl_PL.UTF-8': 'sob. 10 paź 00:04:51 2026'
}

const DARWIN_LOCALE_CATEGORIES = ['LC_COLLATE', 'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME']

function visMetaByte(byte: number): string {
  const low = byte & 0x7f
  if (byte < 0x80) {
    return String.fromCharCode(byte)
  }
  if (low === 0x7f) {
    return 'M^?'
  }
  return low < 0x20 ? `M^${String.fromCharCode(low + 0x40)}` : `M-${String.fromCharCode(low)}`
}

function localeOf(env: NodeJS.ProcessEnv, category: string): string {
  return env.LC_ALL || env[category] || env.LANG || 'C'
}

/** What macOS `ps` prints for `lstart` and argv under the locale `env` selects. */
export function emulateDarwinPsLocale(
  env: NodeJS.ProcessEnv,
  argv: string
): { lstart: string; command: string } {
  const locale = (category: string): string => localeOf(env, category)
  const lstart = DARWIN_LSTART_BY_LOCALE[locale('LC_TIME')]
  if (lstart === undefined) {
    throw new Error(`no captured lstart for ${locale('LC_TIME')}`)
  }
  const locales = new Set(DARWIN_LOCALE_CATEGORIES.map(locale))
  const utf8 = locales.size === 1 && [...locales][0].endsWith('.UTF-8')
  // C or mixed categories drop to the C charset, which prints non-ASCII in vis(3) meta notation.
  const command = utf8 ? argv : [...Buffer.from(argv, 'utf8')].map(visMetaByte).join('')
  return { lstart, command }
}

// procps-ng `ps -o lstart=` for one instant: the issue's de_DE capture and its C form.
const PROCPS_LSTART_BY_LOCALE: Record<string, string> = {
  C: 'Fri Oct  9 22:08:59 2026',
  'en_US.UTF-8': 'Fri Oct  9 22:08:59 2026',
  'de_DE.UTF-8': 'Fr Okt  9 22:08:59 2026'
}

/** What procps-ng `ps` prints for `lstart` and argv under the glibc locale `env` selects. */
export function emulateProcpsLocale(
  env: NodeJS.ProcessEnv,
  argv: string
): { lstart: string; command: string } {
  const lstart = PROCPS_LSTART_BY_LOCALE[localeOf(env, 'LC_TIME')]
  if (lstart === undefined) {
    throw new Error(`no captured lstart for ${localeOf(env, 'LC_TIME')}`)
  }
  // Escaping follows LC_CTYPE's codeset alone; outside UTF-8 every non-ASCII byte prints as `?`.
  const utf8 = localeOf(env, 'LC_CTYPE').endsWith('.UTF-8')
  const asciiOnly = (byte: number): string => (byte < 0x80 ? String.fromCharCode(byte) : '?')
  const command = utf8 ? argv : [...Buffer.from(argv, 'utf8')].map(asciiOnly).join('')
  return { lstart, command }
}

/** One synthetic host supplies requested ps columns, /dev devices, and stable /proc starts. */
export function createProcessTablePsFixture(readRows: () => readonly PsFixtureRow[]) {
  function render(columns: string): string {
    const output = readRows()
      .map((row) =>
        columns
          .split(',')
          .map((column) => {
            switch (column) {
              case 'pid=':
                return row.pid
              case 'ppid=':
                return row.ppid
              case 'pgid=':
                return row.pgid
              case 'tpgid=':
                return row.tpgid
              case 'stat=':
                return row.stat
              case 'tdev=':
                return `16/${row.terminalMinor}`
              case 'tty=':
                return process.platform === 'darwin'
                  ? `ttys${String(row.terminalMinor).padStart(3, '0')}`
                  : `pts/${row.terminalMinor}`
              case 'lstart=':
                return row.startTime
              case 'etimes=':
                // Deliberate drift makes /proc the only stable Linux start marker.
                return String(100 + Math.floor(Date.now() / 1000))
              case 'command=':
                return row.command
              default:
                throw new Error(`unsupported fixture ps column: ${column}`)
            }
          })
          .join(' ')
      )
      .join('\n')
    return `${output}\n`
  }

  function readProcStat(path: string): string {
    const match = path.match(/^\/proc\/(\d+)\/stat$/)
    const row = match ? readRows().find((candidate) => candidate.pid === Number(match[1])) : null
    if (!row) {
      throw new Error(`no fixture process at ${path}`)
    }
    const start = String(row.startTicks)
    return `${row.pid} (fixture) ${['S', ...Array.from({ length: 18 }, () => '0'), start, '0'].join(' ')}`
  }

  function nameTerminals(
    translate: typeof nameDarwinTerminals,
    stdout: string,
    signal?: AbortSignal
  ) {
    const minors = new Set(readRows().map((row) => row.terminalMinor))
    return translate(
      stdout,
      {
        openDirectory: async () =>
          (async function* () {
            for (const minor of minors) {
              yield { name: `ttys${String(minor).padStart(3, '0')}` }
            }
          })(),
        readDevice: async (path: string) => ({
          rdev: (16n << 24n) | BigInt(basename(path).slice(4)),
          isCharacterDevice: () => true
        })
      },
      signal
    )
  }

  return { render, readProcStat, nameTerminals }
}
