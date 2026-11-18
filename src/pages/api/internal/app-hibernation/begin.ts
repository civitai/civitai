import { withAxiom } from '@civitai/next-axiom';
import { createHibernationRoutes } from '~/server/services/app-hibernation/internal-routes';

/**
 * POST /api/internal/app-hibernation/begin — the sandbox service asks to archive a sleeping app: plan-limit check, object keys and presigned PUTs.
 * Contract: `createHibernationRoutes` (signed requests, `internal-routes.ts`).
 */

// The HMAC covers the exact bytes sent; Next's body parser would re-serialise them.
export const config = { api: { bodyParser: false } };

export default withAxiom(createHibernationRoutes().begin);
