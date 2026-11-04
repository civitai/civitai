import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { getRunnerDevTunnelUser } from '~/server/services/app-assistant/app-assistant.service';
import { readAppActivity } from '~/server/services/app-assistant/app-activity.service';
import { readRunnerRequest, runnerAppKey } from '~/server/services/app-assistant/runner-request';

const body = z.object({ grant: z.string().min(1).max(4096), app: runnerAppKey });

export const APP_ACTIVITY_NOT_FOUND_ERROR = 'No app of yours under that key';

/**
 * The handler of `/api/internal/app-assistant/app-activity`: App Assistant's server runner reads
 * the open app's recent activity FOR the user its run grant names, with the same read the page
 * uses (`readAppActivity`). See the route's header for the contract.
 */
export async function runnerAppActivityRoute(req: AxiomAPIRequest, res: NextApiResponse) {
  const request = await readRunnerRequest(req, res, body, 'Expected { grant, app }');
  if (!request) return;
  const { grant: verified, body: parsed } = request;
  const log = (type: string, extra: Record<string, unknown> = {}) =>
    logToAxiom({
      type: `app-assistant.runner-app-activity.${type}`,
      message: `App Assistant runner app activity ${type} for user ${verified.userId}`,
      userId: verified.userId,
      app: parsed.app,
      grantId: verified.grantId,
      ...extra,
    }).catch(() => undefined);

  try {
    // Every gate the runner's token mint checks, then the App Blocks author capability the live
    // preview (whose activity this is) requires.
    const subject = await getRunnerDevTunnelUser(verified.userId);
    if (subject.refusal) {
      if (subject.refusal.code !== 'unavailable') log('refused', { reason: subject.refusal.error });
      return res
        .status(subject.refusal.status)
        .json({ error: subject.refusal.error, code: subject.refusal.code });
    }
    const activity = await readAppActivity({ userId: verified.userId, blockId: parsed.app });
    // One answer for an app that is not theirs and one that does not exist: no oracle.
    if (!activity)
      return res.status(404).json({ error: APP_ACTIVITY_NOT_FOUND_ERROR, code: 'NOT_FOUND' });
    return res.json(activity);
  } catch (err) {
    log('failed', { error: safeError(err) });
    return res
      .status(503)
      .json({ error: 'Could not read the app’s activity right now', code: 'unavailable' });
  }
}
