import { withAxiom } from '@civitai/next-axiom';
import { createHibernationRoutes } from '~/server/services/app-hibernation/internal-routes';

/**
 * POST /api/internal/app-hibernation/secrets — a wake's restore step: the decrypted .env blob of the record the sandbox was seeded from.
 * Contract: `createHibernationRoutes` (signed requests, `internal-routes.ts`).
 */

// The HMAC covers the exact bytes sent; Next's body parser would re-serialise them.
export const config = { api: { bodyParser: false } };

export default withAxiom(createHibernationRoutes().secrets);
