import { withAxiom } from '@civitai/next-axiom';
import { runnerWakeSeedRoute } from '~/server/services/app-assistant/runner-sleeping-apps';

/**
 * POST /api/internal/app-assistant/wake-seed
 *
 * App Assistant's server runner asks for the seed to wake one sleeping app of the user its run
 * grant names: a presigned GET of the archive, its sha256 and size, and a one-time wake ticket.
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`.
 * Body: `{ grant, app }`. Contract: `runnerWakeSeedRoute`.
 */
export default withAxiom(runnerWakeSeedRoute);
