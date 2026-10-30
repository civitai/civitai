import client from 'prom-client';
import type { NextApiRequest } from 'next';
import { BLOCK_TOKEN_QUERY_PROCEDURES } from '~/shared/constants/block-token-transport.constants';

// ---------------------------------------------------------------------------
// Block-token queries still arriving as GET
// ---------------------------------------------------------------------------
//
// The queries in `BLOCK_TOKEN_QUERY_PROCEDURES` carry a bearer block token in their input. The
// current browser client sends them as POST; a GET puts the token in the request URL. Older
// published SDK dev hosts still send GET and must keep working, so the server does not refuse it
// yet. This counter is what that later refusal is gated on: when it has stayed flat long enough,
// refusing GET for these procedures breaks nobody still in use.
//
// Labels: `path` only — a member of the fixed set above, so cardinality is bounded by
// construction. Never a token, a user, an app or a URL.
//
// 🔴 INVARIANT (same as `http-errors.ts` / `trpc-batch.metrics.ts`): import this module ONLY from
// the request webpack graph. prom-client keeps a per-graph default registry and `/api/metrics`
// scrapes the request graph's. Today the only production importer is
// `src/pages/api/trpc/[trpc].ts`.

const NAME = 'civitai_app_block_token_get_requests_total';

declare global {
  // eslint-disable-next-line no-var
  var __civitaiBlockTokenGetRequestCounter: client.Counter<string> | undefined;
}

// Pinned on globalThis so an HMR re-eval reuses the one instance instead of throwing
// prom-client's duplicate-registration error.
export const blockTokenGetRequestCounter: client.Counter<string> =
  globalThis.__civitaiBlockTokenGetRequestCounter ??
  (globalThis.__civitaiBlockTokenGetRequestCounter = new client.Counter({
    name: NAME,
    help: 'tRPC calls to block-token query procedures that arrived as GET, i.e. with the block token in the request URL, by procedure path. UNSAMPLED; one increment per matching procedure call (a batched GET can increment several). The current browser client sends these as POST; GETs come from older SDK dev hosts. Refusing GET for these procedures is gated on this going flat.',
    labelNames: ['path'],
  }));

// Seed every path at 0 so "no GETs" reads as 0 rather than as an absent series.
try {
  for (const path of BLOCK_TOKEN_QUERY_PROCEDURES) blockTokenGetRequestCounter.inc({ path }, 0);
} catch {
  /* never throw from telemetry */
}

/**
 * Count the block-token query calls a GET request carries. A call counts only when the request
 * is a GET, its procedure is in `BLOCK_TOKEN_QUERY_PROCEDURES`, and its `input` query parameter
 * mentions `blockToken` — i.e. a token really is in the URL. Never throws.
 *
 * Cheap on the hot path: every non-GET returns on the method check, and a GET is only split into
 * procedure paths after a substring check on its input finds a `blockToken` key.
 */
export function recordBlockTokenGetRequest(req: Pick<NextApiRequest, 'method' | 'query'>): void {
  try {
    if ((req.method ?? '').toUpperCase() !== 'GET') return;
    const input = req.query?.input;
    if (typeof input !== 'string' || !input.includes('"blockToken"')) return;
    const raw = req.query?.trpc;
    const segment = Array.isArray(raw) ? raw.join(',') : raw;
    if (typeof segment !== 'string') return;
    for (const path of segment.split(',')) {
      if (BLOCK_TOKEN_QUERY_PROCEDURES.has(path)) blockTokenGetRequestCounter.inc({ path });
    }
  } catch {
    /* never throw from telemetry */
  }
}
