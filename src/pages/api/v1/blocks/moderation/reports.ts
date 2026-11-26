import { withAxiom } from '@civitai/next-axiom';
import { withBlockScope } from '~/server/middleware/block-scope.middleware';
import { storageRefusalBody } from '~/server/services/apps/doc-store-api';
import { createReportHandler, REPORT_ENDPOINT } from '~/server/services/apps/doc-store-report-api';

/**
 * `POST /api/v1/blocks/moderation/reports` — report one shared document of the app's storage to
 * the moderators. The body, the gates and the answers are documented in
 * `src/server/services/apps/doc-store-report-api.ts`; this file only wires the route.
 *
 * `apps:storage` is required and is consent-exempt. The route is always on: it is how a report is
 * filed (the storage route's `report` mark alias runs the same code, `fileReport`).
 */

// A report body is three short strings.
export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

// allowOpaqueOrigin: as the storage route — an UNVERIFIED block direct-fetches from an opaque
// origin (`Origin: null`); the Bearer block-JWT (no cookies) remains the sole authz gate.
export default withBlockScope(withAxiom(createReportHandler()), {
  endpoint: REPORT_ENDPOINT,
  requiredScope: 'apps:storage',
  allowOpaqueOrigin: true,
  // The middleware's own refusals in the storage envelope, so every response has one shape.
  formatRefusal: (refusal, req) => storageRefusalBody(refusal, req, REPORT_ENDPOINT),
});
