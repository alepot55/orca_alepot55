import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyAgentWorkspaceTrust } from './agent-workspace-trust'
import { getLocalCodexTrustConfigFiles } from './codex/codex-home-paths'
import { escapeTomlBasicString } from './codex/config-toml-syntax'

let root: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-codex-account-trust-')))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = join(root, 'user-data')
})

afterEach(() => {
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  rmSync(root, { recursive: true, force: true })
})

function readConfig(codexHome: string): string {
  const configPath = join(codexHome, 'config.toml')
  return existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
}

describe('Codex workspace trust for a managed account launch', () => {
  it('trusts the workspace in the CODEX_HOME Orca chose, not one inherited in the env', async () => {
    const home = join(root, 'home')
    const accountHome = join(root, 'user-data', 'codex-accounts', 'account-1', 'home')
    const inheritedHome = join(root, 'parent-orca-codex-home')
    const workspace = join(root, 'worktree')
    mkdirSync(accountHome, { recursive: true })
    mkdirSync(inheritedHome)
    mkdirSync(workspace)

    await applyAgentWorkspaceTrust('codex', workspace, {
      env: { HOME: home, USERPROFILE: home, CODEX_HOME: inheritedHome },
      codexHome: accountHome,
      claudeAuth: null,
      wslDistro: null,
      connectionId: null
    })

    const accountConfig = readConfig(accountHome)
    expect(accountConfig).toContain(`[projects."${escapeTomlBasicString(workspace)}"]`)
    expect(accountConfig).toContain('trust_level = "trusted"')
    expect(readConfig(inheritedHome)).toBe('')
    // Why: the shared runtime mirror and ~/.codex keep their entries for other launch routes.
    expect(readConfig(join(root, 'user-data', 'codex-runtime-home', 'home'))).toContain(
      'trust_level = "trusted"'
    )
    expect(readConfig(join(home, '.codex'))).toContain('trust_level = "trusted"')
  })

  it('lists each config once, every Orca-owned home before ~/.codex', () => {
    const home = join(root, 'home')
    const runtimeHome = join(root, 'user-data', 'codex-runtime-home', 'home')
    const accountHome = join(root, 'user-data', 'codex-accounts', 'account-1', 'home')
    const runtimeConfig = join(runtimeHome, 'config.toml')
    const systemConfig = join(home, '.codex', 'config.toml')
    expect(getLocalCodexTrustConfigFiles(home, accountHome)).toEqual([
      runtimeConfig,
      join(accountHome, 'config.toml'),
      systemConfig
    ])
    expect(getLocalCodexTrustConfigFiles(home, runtimeHome)).toEqual([runtimeConfig, systemConfig])
    expect(getLocalCodexTrustConfigFiles(home, null)).toEqual([runtimeConfig, systemConfig])
    expect(getLocalCodexTrustConfigFiles(home, 'relative/home')).toEqual([
      runtimeConfig,
      systemConfig
    ])
  })
})
