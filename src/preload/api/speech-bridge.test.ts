import { afterEach, describe, expect, it, vi } from 'vitest'
import { speechApi } from './speech-bridge'

const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined))
vi.mock('electron', () => ({ ipcRenderer: { invoke } }))

// Mirrors how the main-process handler rebuilds the samples from the received bytes.
function readSentCall(): { channel: unknown; samples: number[]; rest: unknown[] } {
  const [channel, payload, ...rest] = invoke.mock.calls[0] ?? []
  if (!(payload instanceof Uint8Array)) {
    throw new Error('speech:feedAudio payload must be a Uint8Array')
  }
  const samples = new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4)
  return { channel, samples: Array.from(samples), rest }
}

describe('speech bridge feedAudio', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    invoke.mockClear()
  })

  it('sends the sample bytes without the Buffer global that sandboxed preloads lack', async () => {
    vi.stubGlobal('Buffer', undefined)
    const pending = speechApi.feedAudio(new Float32Array([0.25, -0.5, 1]), 16000, 'session-1')
    vi.unstubAllGlobals()
    await pending

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(readSentCall()).toEqual({
      channel: 'speech:feedAudio',
      samples: [0.25, -0.5, 1],
      rest: [16000, 'session-1']
    })
  })

  it('sends only the bytes of a sample window that does not start at the buffer origin', async () => {
    const window = new Float32Array([9, 0.125, 0.75, 9]).subarray(1, 3)
    await speechApi.feedAudio(window, 48000)

    expect(readSentCall()).toEqual({
      channel: 'speech:feedAudio',
      samples: [0.125, 0.75],
      rest: [48000, 'desktop']
    })
  })
})
