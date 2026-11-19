import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { checkActivityRateLimit } from '~/server/utils/activity-rate-limit';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
import { REST_ERROR_CODE, restErrorBody } from '~/server/utils/rest-error-envelope';
import {
  ACTIVITY_BATCH_MAX,
  ACTIVITY_NAME_MAX_LENGTH,
} from '~/shared/constants/activity-reporting.constants';

// Bounds the bytes parsed before the schema runs. The largest valid body is ACTIVITY_BATCH_MAX
// names of ACTIVITY_NAME_MAX_LENGTH printable ASCII characters, about 41 kB even if every
// character needed a JSON escape.
export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

// No auth on purpose: ActivityReportingProvider posts here from the browser. So every limit the
// client honours is enforced here too, and a batch that breaks one is refused WHOLE, never
// truncated. Names are developer-written `data-activity` slugs (see the constants module); there is
// no enum of them (`tool-click:<id>` is dynamic), so they are bounded by length and charset.
const schema = z.object({
  activities: z
    .array(
      z
        .string()
        .min(1)
        .max(ACTIVITY_NAME_MAX_LENGTH)
        .regex(/^[\x21-\x7e]+$/, 'Activity names are printable ASCII without spaces')
    )
    .max(ACTIVITY_BATCH_MAX),
});

export default async function activity(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.setHeader('Cache-Control', 'no-store');
    return res
      .status(400)
      .json(
        restErrorBody(REST_ERROR_CODE.BAD_REQUEST, 'Invalid activity batch', parsed.error.flatten())
      );
  }
  const { activities } = parsed.data;

  // An unresolved address is not limited: every such caller would otherwise share one bucket.
  const ip = resolveClientIpOrNull(req);
  if (ip) {
    const limit = await checkActivityRateLimit(ip);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      res.setHeader('Cache-Control', 'no-store');
      return res
        .status(429)
        .json(restErrorBody(REST_ERROR_CODE.TOO_MANY_REQUESTS, 'Too many activity reports'));
    }
  }

  const tracker = new Tracker(req, res);
  for (const activity of activities) await tracker.activity(activity);

  return res.status(200).json({ count: activities.length });
}
