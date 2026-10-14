import { useAppStore } from '@/store'

// Why: toggling the menu open and closed must not re-read ~/.ssh/config every time.
const MIN_SYNC_INTERVAL_MS = 5_000

let lastStartedAt = Number.NEGATIVE_INFINITY

/** Pulls new or changed ~/.ssh/config hosts into the host list; best-effort and throttled. */
export async function syncSshConfigHostsPassively(): Promise<void> {
  const now = Date.now()
  if (now - lastStartedAt < MIN_SYNC_INTERVAL_MS) {
    return
  }
  lastStartedAt = now
  try {
    // Why: no reAdopt — hosts the user deleted stay deleted, as in the Settings → SSH sync.
    const result = await window.api.ssh.importConfig()
    const store = useAppStore.getState()
    store.recordSshRepoReadoptions(result.repoReadoptions)
    if (result.targets.length > 0) {
      store.setSshTargetsMetadata(await window.api.ssh.listTargets())
    }
  } catch {
    // Best-effort: Settings → SSH → Import reports config errors on demand.
  }
}
