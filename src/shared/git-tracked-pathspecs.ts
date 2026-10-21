export type TrackedPathSpecHost = {
  // Windows and WSL spell separators with backslashes; on POSIX hosts (including SSH) one is a filename character.
  backslashIsSeparator: boolean
}

function normalizeGitPathForCompare(filePath: string, host: TrackedPathSpecHost): string {
  const slashed = host.backslashIsSeparator ? filePath.replace(/\\/g, '/') : filePath
  return slashed.replace(/\/+$/, '')
}

function createTrackedPathSpecMatcher(
  trackedPaths: readonly string[],
  host: TrackedPathSpecHost
): (filePath: string) => boolean {
  // Normalize lazily so selecting a directory still stops at its first tracked descendant.
  const normalizedTrackedPaths: string[] = []
  return (filePath) => {
    const normalized = normalizeGitPathForCompare(filePath, host)
    const descendantPrefix = `${normalized}/`
    return trackedPaths.some((trackedPath, index) => {
      const normalizedTracked = (normalizedTrackedPaths[index] ??= normalizeGitPathForCompare(
        trackedPath,
        host
      ))
      return normalizedTracked === normalized || normalizedTracked.startsWith(descendantPrefix)
    })
  }
}

export function isTrackedPathSpec(
  filePath: string,
  trackedPaths: readonly string[],
  host: TrackedPathSpecHost
): boolean {
  return createTrackedPathSpecMatcher(trackedPaths, host)(filePath)
}

export function partitionTrackedPathSpecs(
  filePaths: readonly string[],
  trackedPathSpecs: readonly string[],
  host: TrackedPathSpecHost
): { trackedPaths: string[]; untrackedPaths: string[] } {
  const isTracked = createTrackedPathSpecMatcher(trackedPathSpecs, host)
  const trackedPaths: string[] = []
  const untrackedPaths: string[] = []
  // Keep original spellings, duplicates and order: these arrays select restore versus clean.
  for (const filePath of filePaths) {
    ;(isTracked(filePath) ? trackedPaths : untrackedPaths).push(filePath)
  }
  return { trackedPaths, untrackedPaths }
}
