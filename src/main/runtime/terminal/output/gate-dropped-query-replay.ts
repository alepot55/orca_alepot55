import { parseTerminalOscColorQuery } from '../../../../shared/terminal-osc-color-reply'
import {
  findCsiFinalByteIndex,
  isStatefulRendererReplyCsiQuery,
  isStatelessRendererReplyCsiQuery
} from '../../../../shared/terminal-reply-query-extraction'

export type GateDroppedReplayQuery = { sequence: string; stateful: boolean }

/** Reply-eliciting queries in `data`, in stream order, for a replay that answers from the
 *  model's state at the END of `data`. A CPR/DECRQM followed by any non-query byte is left
 *  out: its reply would describe that later state, not the one the program asked about. */
export function selectGateDroppedReplayQueries(data: string): GateDroppedReplayQuery[] {
  const queries: GateDroppedReplayQuery[] = []
  let staleStatefulBefore = 0
  let offset = 0
  while (offset < data.length) {
    const escapeIndex = data.indexOf('\x1b', offset)
    if (escapeIndex !== offset) {
      staleStatefulBefore = queries.length
    }
    if (escapeIndex === -1) {
      break
    }
    const query = matchReplyQueryAt(data, escapeIndex)
    if (query) {
      queries.push(query)
      offset = escapeIndex + query.sequence.length
      continue
    }
    staleStatefulBefore = queries.length
    offset = escapeIndex + 1
  }
  return queries.filter((query, index) => !query.stateful || index >= staleStatefulBefore)
}

function matchReplyQueryAt(data: string, index: number): GateDroppedReplayQuery | null {
  if (data.startsWith('\x1b[', index)) {
    const finalByteIndex = findCsiFinalByteIndex(data, index + 2)
    if (finalByteIndex === -1) {
      return null
    }
    const sequence = data.slice(index, finalByteIndex + 1)
    if (isStatelessRendererReplyCsiQuery(sequence)) {
      return { sequence, stateful: false }
    }
    return isStatefulRendererReplyCsiQuery(sequence) ? { sequence, stateful: true } : null
  }
  const osc = parseTerminalOscColorQuery(data, index)
  return osc.kind === 'match'
    ? { sequence: data.slice(index, osc.endIndex), stateful: false }
    : null
}
