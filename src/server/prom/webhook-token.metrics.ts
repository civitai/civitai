import client from 'prom-client';
import type { NextApiRequest } from 'next';
import { logToAxiom } from '~/server/logging/client';
import { reconstructApiRoute } from '~/server/prom/http-errors';
import { matchWebhookToken, type WebhookTokenSlot } from '~/server/utils/webhook-token';

// Which webhook token slot authenticated each request, so a change of value can be watched: the
// `current` series rises as callers move over, and `previous` falling to 0 is what retiring
// WEBHOOK_TOKEN_PREVIOUS is gated on.
//
// Labels: `slot` and `route` (from `reconstructApiRoute`: params collapsed, no query string). Only
// a request that already matched a configured token is counted, so an unauthenticated caller
// cannot add series.
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
    help: 'Requests authenticated by the webhook token, by which configured value matched (slot=current|previous|probe) and normalized route. UNSAMPLED.',
    labelNames: ['slot', 'route'],
  }));

// The startup and readiness probes (/api/ready, /api/health) authenticate this way every few
// seconds on every pod, so a line per request would flood the logs. One line per route per minute per process says which callers still send the
// previous value; the counter carries the exact numbers.
const PREVIOUS_LOG_INTERVAL_MS = 60_000;
const previousLoggedAt = (globalThis.__civitaiWebhookTokenPreviousLoggedAt ??= new Map());

/** Never throws, and never records the token itself. */
export function recordWebhookTokenMatch(
  req: Pick<NextApiRequest, 'method' | 'url' | 'query' | 'headers'>,
  slot: WebhookTokenSlot
): void {
  try {
    const route = reconstructApiRoute(req as NextApiRequest);
    webhookTokenMatchCounter.inc({ slot, route });
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
