import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { emulateDarwinPsLocale } from '../../shared/process-table-ps-test-fixture'
import { judgeTerminalForeground, readTerminalProcessRows } from './terminal-foreground-group'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

type Row = Omit<ProcessTableRow, 'tty' | 'startTime'>

/** A macOS pane under `login`, as `ps -o pid=,ppid=,pgid=,tpgid=,stat=,command= -t` reads it. */
function pane(tpgid: number, jobs: Omit<Row, 'tpgid'>[]): Row[] {
  return [
    {
      pid: 100,
      ppid: 1,
      pgid: 100,
      tpgid,
      stat: 'Ss',
      command: '/usr/bin/login -flpq user /bin/bash --noprofile --norc -p -c'
    },
    { pid: 101, ppid: 100, pgid: 101, tpgid, stat: tpgid === 101 ? 'S+' : 'S', command: '-zsh' },
    ...jobs.map((job) => ({ ...job, tpgid }))
  ]
}

describe('who holds a pane’s terminal, by its foreground process group', () => {
  it.each([
    // The launch line has not run, or the agent it ran exited and handed the terminal back.
    ['the pane’s shell at its prompt', pane(101, []), 'shell'],
    [
      'the agent the launch line ran',
      pane(200, [{ pid: 200, ppid: 101, pgid: 200, stat: 'S+', command: '/opt/bin/claude' }]),
      'agent'
    ],
    // A tcsh or nu launch line, or a wrapper script that does not `exec` its agent.
    [
      'the agent behind the sh that leads its group',
      pane(200, [
        { pid: 200, ppid: 101, pgid: 200, stat: 'S+', command: '/bin/sh /tmp/orca-launch/run.sh' },
        { pid: 201, ppid: 200, pgid: 200, stat: 'S+', command: '/opt/bin/claude' }
      ]),
      'agent'
    ],
    [
      'an agent it cannot recognize behind a bash wrapper',
      pane(200, [
        { pid: 200, ppid: 101, pgid: 200, stat: 'S+', command: 'bash ./start-agent.sh' },
        { pid: 201, ppid: 200, pgid: 200, stat: 'S+', command: 'node /opt/agent/cli.js' }
      ]),
      'agent'
    ],
    // Between its commands a wrapper is only shells, and typing into it could run the text.
    [
      'a bash wrapper alone',
      pane(200, [{ pid: 200, ppid: 101, pgid: 200, stat: 'S+', command: 'bash ./start-agent.sh' }]),
      'shell'
    ],
    [
      'an agent stopped in the background',
      pane(101, [{ pid: 200, ppid: 101, pgid: 200, stat: 'T', command: '/opt/bin/claude' }]),
      'shell'
    ]
  ] as const)('%s: %s', (_label, rows, found) => {
    expect(judgeTerminalForeground(rows, 100, 'claude')).toBe(found)
  })

  it.each([
    ['the root is not on the terminal', pane(101, []).slice(1)],
    ['the terminal has no foreground group', pane(0, [])],
    ['no process is in the foreground group', pane(300, [])]
  ])('proves nothing when %s', (_label, rows) => {
    expect(judgeTerminalForeground(rows, 100, 'claude')).toBe('unknown')
  })
})

describe('reading a macOS pane’s terminal under the locale Orca was launched with', () => {
  const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  // `à` is C3 A0 in UTF-8, and vis(3) prints A0 as `M- `: a space inside the executable.
  const SHELL = '/Users/càrlo/.nix-profile/bin/zsh'

  afterEach(() => {
    Object.defineProperty(process, 'platform', hostPlatform)
    vi.unstubAllEnvs()
    runProcess.mockReset()
  })

  it.each<Record<string, string>>([
    // Dock launch: no locale at all.
    {},
    { LANG: 'de_DE.UTF-8', LC_TIME: 'en_NZ.UTF-8' }
  ])('reads the shell at the prompt under %o', async (locale) => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'LC_TIME']) {
      vi.stubEnv(name, locale[name])
    }
    runProcess.mockImplementation(
      async (spec: { args: readonly string[]; env?: NodeJS.ProcessEnv }) => {
        const { command } = emulateDarwinPsLocale(spec.env ?? process.env, SHELL)
        const stdout = spec.args.includes('tty=') ? 'ttys003\n' : `101 1 101 101 Ss+ ${command}\n`
        return { code: 0, signal: null, stdout, timedOut: false }
      }
    )

    const rows = await readTerminalProcessRows(101)
    expect(rows?.map((row) => row.command)).toEqual([SHELL])
    expect(judgeTerminalForeground(rows ?? [], 101, 'claude')).toBe('shell')
  })
})
