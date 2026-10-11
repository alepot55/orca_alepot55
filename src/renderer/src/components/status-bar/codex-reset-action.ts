import { toast } from 'sonner'
import type { CodexRateLimitResetOutcome } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'

// Copy mirrors mobile's getCodexResetCreditOutcomeCopy; keep the two in step.
function showOutcomeToast(outcome: CodexRateLimitResetOutcome): void {
  switch (outcome) {
    case 'reset':
      toast.success(
        translate('auto.components.status.bar.StatusBar.codexResetSuccess', 'Codex limits reset')
      )
      return
    case 'alreadyRedeemed':
      // Why: a retry reuses the attempt's idempotency key, so this means the earlier request already reset the limits.
      toast.success(
        translate(
          'auto.components.status.bar.StatusBar.codexResetAlreadyRedeemed',
          'Codex reset already applied'
        )
      )
      return
    case 'nothingToReset':
      toast.info(
        translate(
          'auto.components.status.bar.StatusBar.codexResetNothingToReset',
          'No eligible Codex rate-limit window to reset.'
        )
      )
      return
    case 'noCredit':
      toast.info(
        translate(
          'auto.components.status.bar.StatusBar.codexResetNoCredit',
          'No Codex rate-limit reset is available.'
        )
      )
  }
}

export async function redeemCodexResetWithFeedback(
  consume: () => Promise<CodexRateLimitResetOutcome>
): Promise<void> {
  try {
    showOutcomeToast(await consume())
  } catch (error) {
    console.error('Failed to redeem Codex rate-limit reset from status bar:', error)
    toast.error(
      translate(
        'auto.components.status.bar.StatusBar.codexResetError',
        "Couldn't reset Codex limits. Please try again."
      )
    )
  }
}
