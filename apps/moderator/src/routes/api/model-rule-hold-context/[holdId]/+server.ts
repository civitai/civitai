import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { MODEL_RULE_MATCHES_PATH } from '$lib/model-rule-holds';
import { requireIdParam } from '$lib/server/api-guard';
import { getModelRuleHoldHistory, getOwnerRuleHolds } from '$lib/server/model-rule-holds.queries';

// Each part degrades on its own: a failing history read must not hide what a batch decision covers.
const orNull = <T>(read: Promise<T>) =>
  read.catch((err) => {
    console.error('Model rule hold context failed', err);
    return null;
  });

// Per selected hold: the owner's other pending holds are what a batch decision covers, and the count of
// their other models is the uploader card's line.
export const GET: RequestHandler = async ({ params, locals }) => {
  const holdId = requireIdParam(locals, params.holdId, MODEL_RULE_MATCHES_PATH, 'holdId');
  const [owner, history] = await Promise.all([
    orNull(getOwnerRuleHolds(holdId)),
    orNull(getModelRuleHoldHistory(holdId)),
  ]);
  return json({ owner, history });
};
