import type { ProfilePreferences } from '../persistence/loading-store/profile-preferences'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { resolveHostAgentBaseEnvironment } from '../runtime/structured-agent-shell-environment'

/**
 * Starts this host's commit/PR generation agents from the login-shell environment, as the desktop
 * does; orcad itself starts from a non-login SSH command. Codex/Claude account preparation stays
 * unset: those are desktop flows.
 */
export function installOrcadCommitMessageAgentEnvironment(
  runtime: Pick<OrcaRuntimeService, 'setCommitMessageAgentEnvironmentResolvers'>,
  store: Pick<ProfilePreferences, 'getSettings'>
): void {
  runtime.setCommitMessageAgentEnvironmentResolvers({
    resolveBaseEnvironment: () => resolveHostAgentBaseEnvironment(store.getSettings())
  })
}
