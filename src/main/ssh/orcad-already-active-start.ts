/** Starting an orcad that is recorded active but stopped before a deploy or update looked at it. */
import {
  MANAGED_ORCAD_FENCED_DETAIL,
  MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
} from './orcad-managed-serving'
import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import type { OrcadSlotOptions } from './orcad-recovery-slot'

/** A deploy that finds its version already active never checks it runs; start it on proven exit. */
export async function startStoppedActiveOrcad(slot: OrcadSlotOptions): Promise<void> {
  const wake = await wakeStoppedManagedOrcad(slot)
  if (wake.outcome === 'fenced') {
    throw new Error(MANAGED_ORCAD_FENCED_DETAIL)
  }
  if (wake.outcome === 'not-activated') {
    throw new Error(MANAGED_ORCAD_NOT_ACTIVATED_DETAIL)
  }
  if (wake.outcome === 'recovery-refused') {
    throw new Error(wake.reason)
  }
}
