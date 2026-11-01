import client from 'prom-client';
import type { Counter } from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import { parseVerifiedBotHeader, VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { pageRouteLabel } from '~/server/utils/page-routes';
import { PAGE_ROUTE_HEADER } from '~/shared/constants/page-route.constants';
import { SESSION_UNRESOLVED_REQ_KEY } from '~/shared/constants/render-session.constants';
import { SHELL_REQ_KEY } from '~/shared/constants/shell.constants';

export const TRPC_CALLS_METRIC = PROM_PREFIX + 'trpc_calls_total';
export const PAGE_RENDER_METRIC = PROM_PREFIX + 'page_render_total';

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

function pageRenderCounter(): Counter<'route' | 'authed' | 'bot_class'> {
  return registerInstrumentationMetric(
    PAGE_RENDER_METRIC,
    () =>
      new client.Counter({
        name: PAGE_RENDER_METRIC,
        help:
          'Server-rendered HTML responses, counted once per document: route is the page actually ' +
          'rendered (/404 for notFound, /_error for a thrown error); redirects and /_next/data ' +
          'requests for getServerSideProps pages render no document and are not counted. authed ' +
          'is unknown when the settings bootstrap failed for a request with a session cookie, ' +
          'and shell for a static shell render, which reads no session; ' +
          'bot_class is set only where bot verification runs',
        labelNames: ['route', 'authed', 'bot_class'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

export function botClassLabel(raw: string | string[] | null | undefined): string {
  return parseVerifiedBotHeader(raw) ?? NO_BOT;
}

type HeaderBag = Record<string, string | string[] | undefined>;

/** The request as `_app.getInitialProps` leaves it: `session` set when signed in. */
type RenderRequest = {
  headers: HeaderBag;
  session?: { user?: unknown } | null;
  [SESSION_UNRESOLVED_REQ_KEY]?: boolean;
  [SHELL_REQ_KEY]?: string;
};

/** `shell` for a static shell render, which reads no session: its viewer is unknown by design. */
export function renderAuthedLabel(req: RenderRequest): 'true' | 'false' | 'unknown' | 'shell' {
  if (req[SHELL_REQ_KEY]) return 'shell';
  if (req[SESSION_UNRESOLVED_REQ_KEY]) return 'unknown';
  return req.session?.user ? 'true' : 'false';
}

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

/** Called from `_document.getInitialProps`, which Next runs once per HTML response. */
export function recordPageRender(route: string, req: RenderRequest) {
  try {
    pageRenderCounter().inc({
      route: pageRouteLabel(route),
      authed: renderAuthedLabel(req),
      bot_class: botClassLabel(req.headers[VERIFIED_BOT_HEADER]),
    });
  } catch {
    // Losing one increment is fine.
  }
}
