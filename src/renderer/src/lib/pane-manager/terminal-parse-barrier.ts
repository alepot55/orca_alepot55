type ParseBarrierTarget = {
  write(data: string | Uint8Array, callback?: () => void): void
}

// Why bytes, not '': xterm's resize() drain stops at the first falsy chunk, so an empty string drops its callback and all output queued behind it.
const PARSE_BARRIER_CHUNK = new Uint8Array(0)

/** Queues a zero-byte write; `callback` fires once every earlier write has parsed. */
export function writeTerminalParseBarrier(
  terminal: ParseBarrierTarget,
  callback: () => void
): void {
  terminal.write(PARSE_BARRIER_CHUNK, callback)
}
