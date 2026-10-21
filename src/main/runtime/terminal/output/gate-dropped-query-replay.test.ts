import { describe, expect, it } from 'vitest'
import { selectGateDroppedReplayQueries } from './gate-dropped-query-replay'

const sequences = (data: string): string[] =>
  selectGateDroppedReplayQueries(data).map((query) => query.sequence)

describe('selectGateDroppedReplayQueries', () => {
  it('keeps every query in stream order when only queries follow them', () => {
    expect(sequences('ready> \x1b[6n\x1b[c\x1b[?2004$p')).toEqual([
      '\x1b[6n',
      '\x1b[c',
      '\x1b[?2004$p'
    ])
  })

  it('drops a cursor or mode report that later output would make stale', () => {
    expect(sequences('ab\x1b[6n\x1b[ccd')).toEqual(['\x1b[c'])
    expect(sequences('\x1b[?2004$p\x1b[?2004l')).toEqual([])
    expect(sequences('ab\x1b[6n\r\n')).toEqual([])
  })

  it('keeps a stateful query that comes after the last output', () => {
    expect(sequences('\x1b[6nab\x1b[5n\x1b[6n')).toEqual(['\x1b[5n', '\x1b[6n'])
  })

  it('keeps stateless and OSC color queries wherever they sit', () => {
    expect(sequences('\x1b]11;?\x07text\x1b[>q more')).toEqual(['\x1b]11;?\x07', '\x1b[>q'])
  })

  it('ignores non-query sequences and an unfinished trailing escape', () => {
    expect(sequences('\x1b[31mred\x1b[0m\x1b[')).toEqual([])
  })
})
