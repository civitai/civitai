import { withAxiom } from '@civitai/next-axiom';
import { createHibernationRoutes } from '~/server/services/app-hibernation/internal-routes';

/**
 * POST /api/internal/app-hibernation/commit — the sandbox service reports an uploaded archive: civitai verifies it from storage and records it.
 * Contract: `createHibernationRoutes` (signed requests, `internal-routes.ts`).
 */

// The HMAC covers the exact bytes sent; Next's body parser would re-serialise them.
export const config = { api: { bodyParser: false } };

export default withAxiom(createHibernationRoutes().commit);
