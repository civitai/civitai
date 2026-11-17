import { withAxiom } from '@civitai/next-axiom';
import { runnerSourceSaveRoute } from '~/server/services/app-assistant/source-save-route';

/**
 * POST /api/internal/app-assistant/source-save — the server runner's save of the open app to its
 * source repo. Contract: `runnerSourceSaveRoute`.
 */
export default withAxiom(runnerSourceSaveRoute);
