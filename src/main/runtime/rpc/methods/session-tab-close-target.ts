import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'

// Why: the close path reads only a pane's own `parent::leaf` id as pane intent, so a leaf id must resolve to it.
export function resolveSessionTabPaneCloseTargetId(
  snapshot: RuntimeMobileSessionTabsResult,
  tabId: string,
  leafId: string
): string {
  const pane = snapshot.tabs.find(
    (tab) =>
      tab.type === 'terminal' &&
      tab.leafId === leafId &&
      (tab.id === tabId || tab.parentTabId === tabId)
  )
  if (!pane) {
    throw new Error('tab_not_found')
  }
  return pane.id
}
