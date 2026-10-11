// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { SshTarget } from '../../../../shared/ssh-types'
import { useAppStore } from '../../store'
import { SshStatusSegment } from './SshStatusSegment'

function sshTarget(id: string, label: string): SshTarget {
  return { id, label, configHost: label, host: label, port: 22, username: 'dev' }
}

const alpha = sshTarget('target-alpha', 'alpha-box')
const beta = sshTarget('target-beta', 'beta-box')

const runtimeHost: PublicKnownRuntimeEnvironment = {
  id: 'runtime-build',
  name: 'Build server',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [
    { id: 'build-ws', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://build.invalid' }
  ],
  preferredEndpointId: 'build-ws'
}

const ssh = {
  importConfig: vi.fn(),
  listTargets: vi.fn()
}

// Why: the passive-sync throttle is module state; each case must start well after the last.
let clock = Date.now()

describe('SshStatusSegment ~/.ssh/config sync', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    clock += 60_000
    vi.setSystemTime(clock)
    ssh.importConfig.mockReset()
    ssh.listTargets.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ssh, runtimeEnvironments: {} }
    })
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.getState().setSshTargetsMetadata([alpha])
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'api')
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('lists a host added to ~/.ssh/config once the menu is opened', async () => {
    ssh.importConfig.mockResolvedValue({ targets: [beta], repoReadoptions: [] })
    ssh.listTargets.mockResolvedValue([alpha, beta])
    const user = userEvent.setup({ advanceTimers: () => undefined })
    render(<SshStatusSegment compact={false} iconOnly={false} />)

    await user.click(screen.getByRole('button', { name: 'Remote host connection status' }))

    expect(await screen.findByText('beta-box')).toBeTruthy()
    expect(screen.getByText('alpha-box')).toBeTruthy()
    // Passive sync only: re-adopting would resurrect hosts the user deleted.
    expect(ssh.importConfig).toHaveBeenCalledTimes(1)
    expect(ssh.importConfig).toHaveBeenCalledWith()
  })

  it('keeps the known hosts when the config sync fails', async () => {
    ssh.importConfig.mockRejectedValue(new Error('config unreadable'))
    const user = userEvent.setup({ advanceTimers: () => undefined })
    render(<SshStatusSegment compact={false} iconOnly={false} />)

    await user.click(screen.getByRole('button', { name: 'Remote host connection status' }))

    expect(await screen.findByText('alpha-box')).toBeTruthy()
    expect(ssh.importConfig).toHaveBeenCalledTimes(1)
    expect(ssh.listTargets).not.toHaveBeenCalled()
  })

  it('does not import ~/.ssh/config for a user who only has runtime hosts', async () => {
    useAppStore.setState({ sshTargetLabels: new Map(), runtimeEnvironments: [runtimeHost] })
    const user = userEvent.setup({ advanceTimers: () => undefined })
    render(<SshStatusSegment compact={false} iconOnly={false} />)

    await user.click(screen.getByRole('button', { name: 'Remote host connection status' }))

    expect(await screen.findByText('Build server')).toBeTruthy()
    expect(ssh.importConfig).not.toHaveBeenCalled()
  })
})
