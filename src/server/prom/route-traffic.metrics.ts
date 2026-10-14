import client from 'prom-client';
import type { Counter } from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import { parseVerifiedBotHeader, VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { PAGE_ROUTE_HEADER, pageRouteLabel } from '~/server/utils/page-routes';
import { getAllServerHosts } from '~/server/utils/server-domain';

export const TRPC_CALLS_METRIC = PROM_PREFIX + 'trpc_calls_total';
export const PAGE_RENDER_METRIC = PROM_PREFIX + 'page_render_total';

const OTHER = 'other';
const NO_BOT = 'none';

// Registered on the shared registry: tRPC calls and page renders are recorded from different
// webpack graphs, and `/api/metrics` scrapes this one for both.
function trpcCallsCounter(): Counter<'route' | 'authed'> {
  return registerInstrumentationMetric(
    TRPC_CALLS_METRIC,
    () =>
      new client.Counter({
        name: TRPC_CALLS_METRIC,
        help: 'tRPC procedure calls by the page route that issued them and whether the caller was signed in',
        labelNames: ['route', 'authed'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

function pageRenderCounter(): Counter<'route' | 'authed' | 'bot_class' | 'host'> {
  return registerInstrumentationMetric(
    PAGE_RENDER_METRIC,
    () =>
      new client.Counter({
        name: PAGE_RENDER_METRIC,
        help: 'Server-side page renders by route pattern, sign-in state, verified-bot class and host',
        labelNames: ['route', 'authed', 'bot_class', 'host'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

export function hostLabel(host: string | undefined): string {
  if (!host) return OTHER;
  const bare = host.toLowerCase().replace(/:\d+$/, '');
  return getAllServerHosts().includes(bare) ? bare : OTHER;
}

export function botClassLabel(raw: string | string[] | null | undefined): string {
  return parseVerifiedBotHeader(raw) ?? NO_BOT;
}

type HeaderBag = Record<string, string | string[] | undefined>;

// Metrics must never fail the request they observe.
export function recordTrpcCall(headers: HeaderBag | undefined, authed: boolean) {
  try {
    trpcCallsCounter().inc({
      route: pageRouteLabel(headers?.[PAGE_ROUTE_HEADER]),
      authed: String(authed),
    });
  } catch {
    // Losing one increment is fine.
  }
}

export function recordPageRender({
  route,
  authed,
  headers,
}: {
  route: string;
  authed: boolean;
  headers: HeaderBag;
}) {
  try {
    pageRenderCounter().inc({
      route: pageRouteLabel(route),
      authed: String(authed),
      bot_class: botClassLabel(headers[VERIFIED_BOT_HEADER]),
      host: hostLabel(headers.host as string | undefined),
    });
  } catch {
    // Losing one increment is fine.
  }
}
