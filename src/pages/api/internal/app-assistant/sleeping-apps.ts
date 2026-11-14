import { withAxiom } from '@civitai/next-axiom';
import { runnerSleepingAppsRoute } from '~/server/services/app-assistant/runner-sleeping-apps';

/**
 * POST /api/internal/app-assistant/sleeping-apps
 *
 * App Assistant's server runner reads the sleeping apps (app hibernate) of the user its run grant
 * names. Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`.
 * Body: `{ grant }`. Answers `{ apps }`, or 404 `disabled` while the `app-hibernate` flag is off
 * for the user. Contract: `runnerSleepingAppsRoute`.
 */
export default withAxiom(runnerSleepingAppsRoute);
