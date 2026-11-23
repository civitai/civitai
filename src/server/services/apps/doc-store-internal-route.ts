// The document store's INTERNAL route, `/api/internal/blocks/storage/…`: the one app-data-go
// forwards writes and `info` to (apps/app-data-go/WRITES-DESIGN.md, "The internal route"). It is
// the public route's chain, unchanged and with the same options, behind the caller signature:
//
//   withAppDataSignature( withBlockScope( withAxiom( createStorageHandler({ via: 'service' }) ) ) )
//
// built here rather than in the page so the signature can sit OUTSIDE the block-token middleware
// (nothing, CORS included, runs for an unsigned caller), and so a test can build it over its own
// store. After the signature and before the chain it applies the API region block the public
// route gets from the proxy (`internalRegionGate`). Dark: with `APP_DATA_WRITES_SIGNING_KEY`
// unset every path is a `404 service_route_off`.
//
// The page (`src/pages/api/internal/blocks/storage/[[...path]].ts`) only re-exports
// `internalStorageRoute`. The entries into this chain are a ledger
// (`doc-store-internal-route.test.ts`): the public page and this module, nothing else.
import { withAxiom } from '@civitai/next-axiom';
import { env } from '~/env/server';
import { withBlockScope } from '~/server/middleware/block-scope.middleware';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getApiRegionBlock } from '~/server/middleware/api-request-policy';
import { withAppDataSignature } from '~/server/services/apps/app-data-signature';
import { getRegion } from '~/server/utils/region-blocking';
import {
  createStorageHandler,
  STORAGE_BODY_LIMIT_BYTES,
  storageEndpointLabel,
  storageRefusalBody,
  type StorageApiDeps,
} from '~/server/services/apps/doc-store-api';

export const INTERNAL_STORAGE_PREFIX = '/api/internal/blocks/storage';
export const PUBLIC_STORAGE_PREFIX = '/api/v1/blocks/storage';

export type InternalStorageRouteDeps = Omit<StorageApiDeps, 'via'> & {
  /** The HMAC key, read per request (default: `APP_DATA_WRITES_SIGNING_KEY`). */
  signingKey?: () => string | undefined;
  /** Unix seconds (default: the clock). */
  now?: () => number;
};

/**
 * The API region block the public route gets from the proxy (`apiRegionBlockMiddleware`, whose
 * matcher covers `/api/v1/` but not `/api/internal/`), decided by the same function on the
 * region headers app-data-go forwarded, which the signature covers. The page-only region
 * restriction middleware never runs for an `/api` path, on either route.
 */
export function internalRegionGate(req: NextApiRequest, res: NextApiResponse): boolean {
  const block = getApiRegionBlock(getRegion(req));
  if (!block) return false;
  res.statusCode = block.status;
  res.setHeader('Content-Type', block.contentType);
  res.end(block.body);
  return true;
}

export function createInternalStorageRoute(deps: InternalStorageRouteDeps = {}) {
  const { signingKey, now, ...storage } = deps;
  return withAppDataSignature(
    // The public route's options, verbatim (`src/pages/api/v1/blocks/storage/[[...path]].ts`).
    withBlockScope(withAxiom(createStorageHandler({ ...storage, via: 'service' })), {
      endpoint: storageEndpointLabel,
      requiredScope: 'apps:storage',
      allowOpaqueOrigin: true,
      extraCorsMethods: ['PUT', 'DELETE', 'PATCH'],
      formatRefusal: storageRefusalBody,
    }),
    {
      signingKey: signingKey ?? (() => env.APP_DATA_WRITES_SIGNING_KEY),
      internalPrefix: INTERNAL_STORAGE_PREFIX,
      publicPrefix: PUBLIC_STORAGE_PREFIX,
      bodyLimit: STORAGE_BODY_LIMIT_BYTES,
      now,
      gate: internalRegionGate,
    }
  );
}

export const internalStorageRoute = createInternalStorageRoute();
