import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isPairedWebClientWindow } from '../lib/desktop-window-chrome'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime-client-error-classification'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'

// Web transport phrasings for a host that never answered; the shared classifier lacks them.
const WEB_TRANSPORT_UNREACHABLE_FRAGMENTS = [
  'timed out while connecting to the remote orca runtime',
  'remote orca runtime connection interrupted'
]

/** A paired web client whose host never answered at boot: nothing hydrated, so a reload is a clean retry. */
export function isPairedHostUnreachableAtStartup(error: unknown): boolean {
  if (!isPairedWebClientWindow()) {
    return false
  }
  const reported = toRemoteRuntimeClientErrorLike(error)
  // Why: a coded failure is the host's own reply, and reloading on it would loop while it answers.
  if (reported.code) {
    return false
  }
  const message = reported.message.toLowerCase()
  return (
    isRecoverableRemoteRuntimeConnectionError(reported) ||
    WEB_TRANSPORT_UNREACHABLE_FRAGMENTS.some((fragment) => message.includes(fragment))
  )
}

function isTransportReady(snapshot: RuntimeHostStatusSnapshot): boolean {
  return snapshot.transport === 'ready' && !snapshot.retired
}

// Why: a host that keeps dropping the socket mid-boot would otherwise auto-reload forever.
const AUTO_RELOAD_MARKER_KEY = 'orca:paired-host-unreachable-auto-reload-at'
// A reload's next document starts within this window of the marker; later loads ignore it.
const AUTO_RELOAD_LANDING_WINDOW_MS = 30_000

/** False when this document is the product of our own auto reload, or storage cannot tell. */
function claimAutoReload(): boolean {
  try {
    const markedAt = Number(window.sessionStorage.getItem(AUTO_RELOAD_MARKER_KEY))
    window.sessionStorage.removeItem(AUTO_RELOAD_MARKER_KEY)
    return !(markedAt > 0 && performance.timeOrigin - markedAt < AUTO_RELOAD_LANDING_WINDOW_MS)
  } catch {
    return false
  }
}

function markAutoReload(): boolean {
  try {
    window.sessionStorage.setItem(AUTO_RELOAD_MARKER_KEY, String(Date.now()))
    return true
  } catch {
    return false
  }
}

/** Says the host is unreachable and reloads once its transport is ready, never twice in a row. */
export function showPairedHostUnreachableAtStartup(): void {
  let reloading = false
  const reload = (): void => {
    if (reloading) {
      return
    }
    reloading = true
    void window.api.app.reload()
  }
  toast.warning(
    translate('auto.store.slices.runtime.status.runtimeHostUnreachable', "Can't reach Orca server"),
    {
      description: translate(
        'auto.store.slices.runtime.status.runtimeHostDisconnectedDescription',
        'Check that Orca is running on this server and that your network connection is working, then try again.'
      ),
      duration: Infinity,
      dismissible: true,
      action: {
        label: translate('auto.store.slices.runtime.status.tryAgain', 'Try again'),
        onClick: reload
      }
    }
  )
  // Why: an auto-reloaded boot that fails again leaves the retry to the user instead of looping.
  if (!claimAutoReload()) {
    return
  }
  const autoReload = (): void => {
    if (!reloading && markAutoReload()) {
      reload()
    }
  }
  // Why: the web transport reconnects on its own, so its first ready snapshot means the host is back.
  window.api.runtimeEnvironments.onStatusChanged((snapshot) => {
    if (isTransportReady(snapshot)) {
      autoReload()
    }
  })
  // Why: the transport may have reconnected before the subscription above existed.
  void window.api.runtimeEnvironments.getStatusSnapshots().then(
    (snapshots) => {
      if (snapshots.some(isTransportReady)) {
        autoReload()
      }
    },
    () => undefined
  )
}
