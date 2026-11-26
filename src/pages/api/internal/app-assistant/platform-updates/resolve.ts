import { withAxiom } from '@civitai/next-axiom';
import { runnerPlatformUpdateResolveRoute } from '~/server/services/app-assistant/runner-platform-updates-route';

/**
 * POST /api/internal/app-assistant/platform-updates/resolve — the server runner reports a staff
 * platform update merged into the open app (saved first) or conflicted. Contract:
 * `runner-platform-updates.ts`.
 */
export default withAxiom(runnerPlatformUpdateResolveRoute);
