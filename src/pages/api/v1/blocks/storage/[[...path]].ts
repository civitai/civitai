import { withAxiom } from '@civitai/next-axiom';
import { withBlockScope } from '~/server/middleware/block-scope.middleware';
import { createStorageHandler, storageEndpointLabel } from '~/server/services/apps/doc-store-api';

/**
 * `/api/v1/blocks/storage/…` — the App Blocks document store. Every path, the reserved
 * segments, the error envelope and the gates are documented in
 * `src/server/services/apps/doc-store-api.ts`; this file only wires the route.
 *
 * `apps:storage` is required for every operation and is consent-exempt; the consent-gated
 * `apps:storage:publish` is checked in the handler, only for document writes into shared
 * collections that viewers author. Inert until `APPDATA_DATABASE_URL` is configured: the
 * store answers every data operation `503 storage_disabled`.
 */

// A document is at most 64 KiB stored. The parser limit sits above that so the store, not
// Next, answers an oversized write — with `too_large` in the house envelope.
export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque origin
// (`Origin: null`); the Bearer block-JWT (no cookies) remains the sole authz gate — see
// WithBlockScopeOpts.allowOpaqueOrigin. extraCorsMethods: documents are written with PUT and
// deleted with DELETE, which the preflight must allow.
export default withBlockScope(withAxiom(createStorageHandler()), {
  endpoint: storageEndpointLabel,
  requiredScope: 'apps:storage',
  allowOpaqueOrigin: true,
  extraCorsMethods: ['PUT', 'DELETE'],
});
