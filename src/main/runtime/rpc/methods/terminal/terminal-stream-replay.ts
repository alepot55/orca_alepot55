import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences,
  type TerminalReplyQuerySequence
} from '../../../../../shared/terminal-reply-query-scan'
import {
  iterateTerminalOutputFrameChunks,
  type TerminalOutputFrameChunk,
  type TerminalOutputMeta
} from '../../terminal-output-frame-chunks'
import {
  measureTerminalStreamByteLength,
  terminalStreamByteLength
} from '../../terminal-stream-byte-length'
import { TERMINAL_MULTIPLEX_PENDING_MAX_BYTES } from '../../../../../shared/terminal-multiplex-flow-control'
import type {
  PendingReplyQueries,
  TerminalMultiplexStream,
  TerminalOutputChunk
} from './terminal-stream-types'

export const TERMINAL_QUERY_REPLAY_MAX_CHARS = 16 * 1024

export function createPendingReplyQueries(): PendingReplyQueries {
  return {
    scanState: EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
    sequences: [],
    chars: 0,
    overflowed: false
  }
}

function capturePendingReplyQueries(
  queries: PendingReplyQueries,
  data: string,
  meta?: TerminalOutputMeta
): void {
  if (queries.overflowed) {
    return
  }
  if (typeof meta?.seq !== 'number' || meta.rawLength !== data.length) {
    queries.scanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    return
  }
  const scan = scanTerminalReplyQuerySequences(data, meta.seq - data.length, queries.scanState)
  queries.scanState = scan.state
  for (const query of scan.queries) {
    if (queries.chars + query.data.length > TERMINAL_QUERY_REPLAY_MAX_CHARS) {
      queries.overflowed = true
      return
    }
    queries.sequences.push(query)
    queries.chars += query.data.length
  }
}

/** Queries the snapshot fully covers (all of them when buffered output was dropped), in stream order. */
export function getSnapshotQueryReplayData(
  queries: PendingReplyQueries | null,
  snapshotSeq: number | undefined,
  outputDropped: boolean,
  pendingEscapeTailAnsi: string | undefined
): string {
  if (!queries || queries.overflowed) {
    return ''
  }
  // Why endSeq: a query split by the snapshot completes live from its pendingEscapeTailAnsi.
  const replay = queries.sequences
    .filter(
      (query) => outputDropped || (typeof snapshotSeq === 'number' && query.endSeq <= snapshotSeq)
    )
    .map((query) => query.data)
    .join('')
  // Why: the replay's ESC aborts the tail the client wrote last; re-arm it so the next live chunk still completes it (#7329).
  return replay && replay + (pendingEscapeTailAnsi ?? '')
}

export function appendPendingMultiplexOutput(
  stream: TerminalMultiplexStream,
  data: string,
  meta?: TerminalOutputMeta
): void {
  if (stream.initialSnapshotQueries) {
    capturePendingReplyQueries(stream.initialSnapshotQueries, data, meta)
  }
  const remainingBudget = Math.max(
    1,
    TERMINAL_MULTIPLEX_PENDING_MAX_BYTES - stream.pendingOutputBytes
  )
  const measurement = measureTerminalStreamByteLength(data, {
    stopAfterBytes: remainingBudget
  })
  stream.pendingOutput.push({ data, bytes: measurement.byteLength, meta })
  stream.pendingOutputBytes += measurement.byteLength
  const trimmed = trimPendingOutputToBudget(stream.pendingOutput, stream.pendingOutputBytes)
  stream.pendingOutputBytes = trimmed.bytes
  stream.pendingOutputOverflowed ||= trimmed.overflowed
}

export function getOutputAfterSnapshotSeq(
  chunk: TerminalOutputChunk,
  snapshotSeq: number | undefined
): TerminalOutputChunk | null {
  if (
    typeof snapshotSeq !== 'number' ||
    typeof chunk.meta?.seq !== 'number' ||
    typeof chunk.meta.rawLength !== 'number'
  ) {
    return chunk
  }
  if (chunk.meta.seq <= snapshotSeq) {
    return null
  }
  const chunkStartSeq = chunk.meta.seq - chunk.meta.rawLength
  if (chunkStartSeq >= snapshotSeq) {
    return chunk
  }
  if (chunk.meta.transformed) {
    return null
  }
  const offset = snapshotSeq - chunkStartSeq
  return {
    data: chunk.data.slice(offset),
    bytes: chunk.bytes,
    meta: {
      ...chunk.meta,
      rawLength: chunk.meta.rawLength - offset
    }
  }
}

export function stripSnapshotBoundaryQuerySuffixes(
  data: string,
  dataStartSeq: number,
  snapshotSeq: number,
  queries: TerminalReplyQuerySequence[]
): string {
  let output = ''
  let offset = 0
  for (const query of queries) {
    if (query.startSeq >= snapshotSeq || query.endSeq <= snapshotSeq) {
      continue
    }
    const removeStart = Math.max(0, query.startSeq - dataStartSeq)
    const removeEnd = Math.min(data.length, query.endSeq - dataStartSeq)
    if (removeEnd <= offset || removeStart >= data.length) {
      continue
    }
    output += data.slice(offset, removeStart)
    offset = removeEnd
  }
  return output + data.slice(offset)
}

export function appendAckPendingOutput(
  stream: TerminalMultiplexStream,
  chunk: TerminalOutputFrameChunk
): void {
  stream.ackPendingOutput.push(chunk)
  stream.ackPendingOutputBytes += chunk.bytes.byteLength
  const trimmed = trimHeadToBudget(
    stream.ackPendingOutput,
    stream.ackPendingOutputBytes,
    (pending) => pending.bytes.byteLength
  )
  stream.ackPendingOutputBytes = trimmed.bytes
  stream.ackPendingOutputOverflowed ||= trimmed.overflowed
}

export function trimPendingOutputToBudget(
  pendingOutput: TerminalOutputChunk[],
  pendingOutputBytes: number
): { bytes: number; overflowed: boolean } {
  return trimHeadToBudget(pendingOutput, pendingOutputBytes, (chunk) => chunk.bytes)
}

function trimHeadToBudget<T>(
  items: T[],
  bytes: number,
  sizeOf: (item: T) => number
): { bytes: number; overflowed: boolean } {
  let omittedCount = 0
  while (bytes > TERMINAL_MULTIPLEX_PENDING_MAX_BYTES && omittedCount < items.length) {
    bytes -= sizeOf(items[omittedCount]!)
    omittedCount += 1
  }
  if (omittedCount > 0) {
    items.splice(0, omittedCount)
  }
  return { bytes, overflowed: omittedCount > 0 }
}

export function trimPendingOutputCoveredBySnapshot(
  pendingOutput: TerminalOutputChunk[],
  snapshotSeq: number | undefined
): { chunks: TerminalOutputChunk[]; bytes: number } {
  if (typeof snapshotSeq !== 'number') {
    return {
      chunks: pendingOutput,
      bytes: pendingOutput.reduce((sum, chunk) => sum + chunk.bytes, 0)
    }
  }
  const chunks: TerminalOutputChunk[] = []
  let bytes = 0
  for (const chunk of pendingOutput) {
    const chunkSeq = chunk.meta?.seq
    const rawLength = chunk.meta?.rawLength ?? chunk.data.length
    if (typeof chunkSeq !== 'number' || rawLength !== chunk.data.length) {
      chunks.push(chunk)
      bytes += chunk.bytes
      continue
    }
    const startSeq = chunkSeq - rawLength
    if (snapshotSeq >= chunkSeq) {
      continue
    }
    if (snapshotSeq <= startSeq) {
      chunks.push(chunk)
      bytes += chunk.bytes
      continue
    }
    const data = chunk.data.slice(snapshotSeq - startSeq)
    const slicedBytes = terminalStreamByteLength(data)
    chunks.push({ data, bytes: slicedBytes, meta: undefined })
    bytes += slicedBytes
  }
  return { chunks, bytes }
}

export function* iterateTerminalStreamTextPayloads(
  data: string
): Generator<Uint8Array<ArrayBufferLike>> {
  if (!data) {
    return
  }
  for (const chunk of iterateTerminalOutputFrameChunks(data)) {
    yield chunk.bytes
  }
}

export function isTerminalReadPayloadIncomplete(read: {
  truncated: boolean
  limited?: boolean
}): boolean {
  // Why: a limited preview is an incomplete payload even when the retained buffer wasn't truncated.
  return read.truncated || read.limited === true
}

export function normalizeMultiplexSnapshotScrollbackRows(
  value: number | undefined
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.max(0, Math.min(50_000, Math.floor(value)))
}

export function requestedSnapshotScrollbackCandidates(requestedRows: number | undefined): number[] {
  const candidates = [requestedRows ?? 0, 1000, 500, 250, 100, 25, 0]
    .filter((rows): rows is number => typeof rows === 'number')
    .map((rows) => Math.max(0, Math.min(50_000, Math.floor(rows))))
  return [...new Set(candidates)]
}
