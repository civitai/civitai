import type { NextApiRequest, NextApiResponse } from 'next';
import { getRandomInt } from '~/utils/number-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

// Liveness probe. Returns 200 if the Node.js process is alive and
// the event loop is responsive. Intentionally has no dependency
// calls (DB, Redis, ClickHouse, MeiliSearch) so a slow upstream
// can't trigger kubelet to restart pods. Use /api/health for the
// deep readiness check.
export default WebhookEndpoint(async (_req: NextApiRequest, res: NextApiResponse) => {
  return res.status(200).json({
    podname: process.env.PODNAME ?? getRandomInt(100, 999),
    version: process.env.version,
    alive: true,
  });
});
