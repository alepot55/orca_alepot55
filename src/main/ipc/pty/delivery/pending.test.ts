import { describe, expect, it } from 'vitest'
import { pendingPtyDataEndSeq } from './pending'

describe('pendingPtyDataEndSeq', () => {
  it('ends at the start sequence plus the queued text', () => {
    expect(pendingPtyDataEndSeq({ data: 'abc', startSeq: 10 })).toBe(13)
  })

  it('counts raw output, not transformed text, when the two differ', () => {
    expect(
      pendingPtyDataEndSeq({ data: 'ab', startSeq: 10, rawLength: 5, transformed: true })
    ).toBe(15)
  })

  it('is unknown once the pending cap kept only query bytes', () => {
    expect(pendingPtyDataEndSeq({ data: '\x1b[6n', droppedOutput: true })).toBeUndefined()
  })
})
