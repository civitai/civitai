import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import {
  decidePayoutReview,
  payoutReviewDecisionSchema,
} from '~/server/services/creator-program-prepayout-review/hold';
import { handleEndpointError, WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/** Records a decision on a held Creator Program payout: escalate, clear or withhold. */
export default WebhookEndpoint(async function (req: AxiomAPIRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed. Use POST.');

  const parsed = payoutReviewDecisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    return res.status(200).json(await decidePayoutReview(parsed.data));
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
