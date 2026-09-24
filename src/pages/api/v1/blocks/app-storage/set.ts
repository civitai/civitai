import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { appStorageSetInput, setAppStorageValue } from '~/server/services/apps/app-storage.service';
import { blockBearerToken } from '~/server/utils/block-bearer';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * POST /api/v1/blocks/app-storage/set  body `{ key, value }` → `{ ok, sizeBytes }`
 * Scope `apps:storage:write`.
 *
 * Upsert one key of the viewer's OWN per-app KV — the REST twin of the
 * `APP_STORAGE_SET` bridge message, and the highest-consequence route on this
 * surface: it is the only one that consumes quota.
 *
 * A thin adapter over `setAppStorageValue`, the SAME function
 * `trpc.apps.storage.set` calls, so every ceiling runs verbatim, in one place,
 * and none of them is re-spelled here:
 *   - the 64KB PER_VALUE_BYTE_CAP, checked in the WIRE unit;
 *   - the per-app 50MB byte ceiling and 1M-row ceiling;
 *   - the viewer's OWN per-user byte + row sub-budget, and the `42P01` fallback
 *     that keeps an un-backfilled app serving rather than failing closed;
 *   - the stored-vs-wire unit handling that makes the non-increasing exemption
 *     safe (a bug that was a repeatable bypass of BOTH byte ceilings when the
 *     delta was held in the wrong unit);
 *   - the (block_instance, viewer) tuple binding and the per-op scope assertion.
 * See `APP STORAGE: ONE BODY, TWO TRANSPORTS` in `apps.router.ts`.
 *
 * 🔴 A FAILED WRITE REJECTS — IT NEVER RESOLVES `{ ok: false }`, and a consumer
 * depends on that. `civitai-app-model-benchmarking` claims an in-flight marker in
 * this store BEFORE it spends the viewer's Buzz and treats a rejection as "the
 * claim did not land, do not spend". A soft-failure envelope would be read as a
 * successful claim and would turn every quota rejection into a double-charge. So
 * the shared body's contract is preserved exactly: success → 200
 * `{ ok: true, sizeBytes }`; every refusal → a thrown TRPCError → non-2xx through
 * `handleEndpointError`. `PAYLOAD_TOO_LARGE` maps to 413, the quota refusals to
 * their own statuses. There is no 2xx path that means "not written".
 *
 * 🔴 `sizeBytes` IS THE WIRE UNIT, NOT THE STORED UNIT, and the difference is not
 * cosmetic. It is `Buffer.byteLength(JSON.stringify(value))`, so a block can
 * predict a `PAYLOAD_TOO_LARGE` from the value it holds; the quota counters are
 * in Postgres' `octet_length(value::text)` over JSONB, which for numeric-heavy
 * payloads has been measured at up to 44.4x the wire size. A block that sums
 * `sizeBytes` to predict its quota consumption WILL under-count. Read
 * `/app-storage/quota` for the authoritative number.
 *
 * An ANONYMOUS viewer gets 403 before this handler runs — see `get.ts` for why
 * that is deliberate and what it diverges from. (The shared body's own anon arm
 * throws UNAUTHORIZED, so a write was never anonymous on either transport; only
 * the status code differs.)
 *
 * Response: `{ ok: true, sizeBytes }`.
 */

// The value is bounded by PER_VALUE_BYTE_CAP (64KB, wire unit) inside the shared
// body. The parser limit is set ABOVE that deliberately: at 64kb Next would
// answer an oversized write with its own opaque 413 before the handler ran, and
// the caller would lose the body's specific `value exceeds 64KB cap` message —
// which is the message that tells an app WHICH ceiling it hit. Headroom lets the
// real gate answer.
export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };

// Exported for unit testing (the default export is wrapped in withBlockScope,
// whose JWT gate would otherwise have to be satisfied to reach this handler).
export const baseHandler = withAxiom(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  // Parsed with the procedure's OWN schema (imported, not re-spelled).
  const parsed = appStorageSetInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await setAppStorageValue(
      blockBearerToken(req),
      parsed.data.key,
      parsed.data.value
    );
    res.status(200).json(result);
    return;
  } catch (error) {
    // See get.ts — `handleEndpointError`, so failures answer `{ message }` and
    // this route stays off the known-leak list in
    // `rest-error-envelope-ledger.test.ts`.
    return handleEndpointError(res, error);
  }
});

// 🔴 NO `stashBlockActionDetail` HERE, AND THE OMISSION IS DELIBERATE — same
// decision #5068 recorded for `workflows/submit.ts`, for the same reason.
// `setAppStorageValue` already writes its OWN `block_scope_invocations` row
// (`endpoint: 'storage:set'`, `detail.action: 'storage.set'`, carrying the key),
// and it is the better row: it is the only writer that knows the key, which is
// what the Activity panel renders. `withBlockScope` then writes its own access
// row for this REST call, as it does for every wrapped route. So ONE REST write
// produces TWO rows where the same write over the bridge produces one —
// `Wrote app-local storage · storage:set` and `Wrote app-local storage (API) ·
// /api/v1/blocks/app-storage/set`. That cost is stated rather than left to be
// discovered; the labels are deliberately DIFFERENT so the pair reads as
// "action + the API call that caused it" rather than as two identical writes.
// Removing the second row would need a new `withBlockScope` suppression option,
// i.e. a middleware change on every route's audit path — out of scope here, and
// named in `AppActivityPanel.tsx` as the real fix if the noise is judged too high.
//
// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'app_storage_set',
  requiredScope: 'apps:storage:write',
  allowOpaqueOrigin: true,
});
