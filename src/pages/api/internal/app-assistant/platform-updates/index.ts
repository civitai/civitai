import { withAxiom } from '@civitai/next-axiom';
import { runnerPlatformUpdatesRoute } from '~/server/services/app-assistant/runner-platform-updates-route';

/**
 * POST /api/internal/app-assistant/platform-updates — the server runner reads the open app's
 * pending staff platform updates, with the files each one changes, for the user its run grant
 * names. Contract: `runner-platform-updates.ts`.
 */
export default withAxiom(runnerPlatformUpdatesRoute);
