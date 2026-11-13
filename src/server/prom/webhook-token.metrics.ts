import client from 'prom-client';
import type { NextApiRequest } from 'next';
import { logToAxiom } from '~/server/logging/client';
import { reconstructApiRoute } from '~/server/prom/http-errors';
import { matchWebhookToken, type TokenMatchSlot } from '~/server/utils/webhook-token';

// Which token slot authenticated each request, so a change of value can be watched: the `current`
// series rises as callers move over, and `previous` falling to 0 is what retiring
// WEBHOOK_TOKEN_PREVIOUS is gated on. `probe` is PROBE_TOKEN, which only the health routes accept.
//
// Labels: `slot`, `route` (from `reconstructApiRoute`: params collapsed, no query string) and
// `caller` (the user-agent's client family, from a fixed list; see `callerFamily`). Only a request
// that already matched a configured token is counted, so an unauthenticated caller cannot add series.
//
// 🔴 Same invariant as `http-errors.ts`: import only from the request webpack graph, which is the
// registry `/api/metrics` scrapes.

declare global {
  // eslint-disable-next-line no-var
  var __civitaiWebhookTokenMatchCounter: client.Counter<string> | undefined;
  // eslint-disable-next-line no-var
  var __civitaiWebhookTokenPreviousLoggedAt: Map<string, number> | undefined;
}

export const webhookTokenMatchCounter: client.Counter<string> =
  globalThis.__civitaiWebhookTokenMatchCounter ??
  (globalThis.__civitaiWebhookTokenMatchCounter = new client.Counter({
    name: 'civitai_webhook_token_match_total',
    help: 'Requests authenticated by a configured token, by which value matched (slot=current|previous for the webhook token, probe for PROBE_TOKEN on the health routes), normalized route and user-agent client family (caller). UNSAMPLED.',
    labelNames: ['slot', 'route', 'caller'],
  }));

// Lowercased user-agent prefix -> family. First match wins. The raw user-agent never becomes a
// label: anything unlisted is `other`, so the label has at most CALLER_FAMILIES.length values.
const CALLER_PREFIXES: ReadonlyArray<readonly [prefix: string, family: string]> = [
  ['kube-probe/', 'kube-probe'],
  ['prometheus/', 'prometheus'],
  ['undici', 'node'],
  ['node', 'node'],
  ['axios/', 'node'],
  ['got ', 'node'],
  ['python-requests/', 'python'],
  ['python-httpx/', 'python'],
  ['python-urllib/', 'python'],
  ['python/', 'python'],
  ['aiohttp/', 'python'],
  ['go-http-client/', 'go'],
  ['curl/', 'curl'],
  ['okhttp/', 'java'],
  ['java-http-client/', 'java'],
  ['java/', 'java'],
  ['apache-httpclient/', 'java'],
  ['mozilla/', 'browser'],
];

export const CALLER_FAMILIES = [
  ...new Set(CALLER_PREFIXES.map(([, family]) => family)),
  'none',
  'other',
];

/** The client family of a user-agent header: a value of `CALLER_FAMILIES`, never the header itself. */
export function callerFamily(userAgent: string | undefined): string {
  const ua = userAgent?.trim().toLowerCase();
  if (!ua) return 'none';
  return CALLER_PREFIXES.find(([prefix]) => ua.startsWith(prefix))?.[1] ?? 'other';
}

// Probes call the health routes (/api/live, /api/ready, /api/health) every few seconds on every pod,
// so while they still send the previous value a line per request would flood the logs. One line
// per route per minute per process says which callers still send it; the counter carries the
// exact numbers.
const PREVIOUS_LOG_INTERVAL_MS = 60_000;
const previousLoggedAt = (globalThis.__civitaiWebhookTokenPreviousLoggedAt ??= new Map());

/** Never throws, and never records the token itself. */
export function recordWebhookTokenMatch(
  req: Pick<NextApiRequest, 'method' | 'url' | 'query' | 'headers'>,
  slot: TokenMatchSlot
): void {
  try {
    const route = reconstructApiRoute(req as NextApiRequest);
    webhookTokenMatchCounter.inc({
      slot,
      route,
      caller: callerFamily(req.headers?.['user-agent']),
    });
    if (slot !== 'previous') return;

    const now = Date.now();
    if (now - (previousLoggedAt.get(route) ?? 0) < PREVIOUS_LOG_INTERVAL_MS) return;
    previousLoggedAt.set(route, now);
    logToAxiom({
      name: 'webhook-token-previous-match',
      type: 'info',
      slot,
      route,
      userAgent: req.headers?.['user-agent'],
    }).catch(() => undefined);
  } catch {
    /* never throw from telemetry */
  }
}

/** Whether `presented` is a configured webhook token, recording which slot matched when it is. */
export function webhookTokenAuthenticates(
  req: Pick<NextApiRequest, 'method' | 'url' | 'query' | 'headers'>,
  presented: unknown
): boolean {
  const slot = matchWebhookToken(presented);
  if (slot) recordWebhookTokenMatch(req, slot);
  return !!slot;
}
