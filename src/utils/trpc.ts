// src/utils/trpc.ts
import { QueryClient, type QueryClientConfig } from '@tanstack/react-query';
import type { CreateTRPCClient, TRPCLink } from '@trpc/client';
import { createTRPCClient, httpLink, loggerLink, splitLink } from '@trpc/client';
import type { CreateTRPCNext } from '@trpc/next';
import { createTRPCNext } from '@trpc/next';
import type { NextPageContext } from 'next';
import superjson from 'superjson';
import type { AppRouter } from '~/server/routers';
import { isDev } from '~/env/other';
import { env } from '~/env/client';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { shouldRouteToGateway } from '~/utils/orchestrator-gateway-routing';

type RequestHeaders = {
  'x-client-date': string;
  'x-client': string;
  'x-client-version'?: string;
};

const url = '/api/trpc';

/**
 * Base URL of the dedicated orchestrator-gateway service (generation-API
 * spin-out). Empty by default → the split falls back to the monolith. When set
 * (an absolute origin) the client MAY route allowlisted `orchestrator.*` calls
 * here. Trailing `/api/trpc` mirrors the monolith URL shape so the gateway's
 * tRPC-over-HTTP handler mounts at the same relative path.
 */
const gatewayBase = env.NEXT_PUBLIC_ORCHESTRATOR_GATEWAY_URL || '';
const gatewayUrl = gatewayBase ? `${gatewayBase.replace(/\/$/, '')}${url}` : '';

/**
 * Module-scope cache of the `orchestratorGatewayRouting` cohort flag. The tRPC
 * link chain runs OUTSIDE React, so it can't read `useFeatureFlags()`; instead
 * `FeatureFlagsProvider` (seeded synchronously from the SSR `flags`) writes the
 * boolean here on mount via `setGatewayRouting`. Safe default `false` → monolith
 * until populated / for anon / on error. Because the procedure allowlist ships
 * EMPTY, this being true is still a provable no-op.
 */
let gatewayRoutingEnabled = false;
export function setGatewayRouting(enabled: boolean) {
  gatewayRoutingEnabled = enabled;
}

/**
 * Approximate input-size threshold (serialized chars) above which a query is
 * sent as POST instead of GET. Mirrors the old ~4000-char GET URL budget: the
 * percent-encoded URL runs ~1.4x the raw input JSON, so ~2500 chars of input
 * lands around the 4000-char URL limit where proxies / HTTP header limits start
 * rejecting (HTTP 431).
 */
const MAX_QUERY_INPUT_LENGTH = 2500;

/**
 * Whether a query's input is large enough that carrying it in the URL as a GET
 * would risk HTTP 431 (Request Header Fields Too Large) / proxy URL limits.
 * Such queries are routed through tRPC's native `methodOverride: 'POST'`, which
 * moves the input into the request body. Requires `allowMethodOverride: true`
 * on the server adapter — see `src/pages/api/trpc/[trpc].ts`.
 */
function isLargeQuery(op: { type: string; input: unknown }) {
  if (op.type !== 'query' || op.input == null) return false;
  try {
    return JSON.stringify(op.input).length > MAX_QUERY_INPUT_LENGTH;
  } catch {
    return false;
  }
}

/**
 * Terminating link: large queries go out as POST (body-carried input, not
 * edge-cacheable), everything else stays a normal GET so the `responseMeta`
 * Cache-Control headers in `[trpc].ts` can still edge-cache them.
 */
function httpLinkWithLargeQuerySupport({
  url,
  headers,
}: {
  url: string;
  headers: ReturnType<typeof getHeaders>;
}): TRPCLink<AppRouter> {
  return splitLink({
    condition: isLargeQuery,
    true: httpLink({ transformer: superjson, url, methodOverride: 'POST', headers }),
    false: httpLink({ transformer: superjson, url, headers }),
  });
}
/**
 * Wrap a monolith terminating link with the DARK orchestrator-gateway split.
 *
 * `condition` true  → route the op to the gateway (reusing
 *   `httpLinkWithLargeQuerySupport` so the large-query POST behavior is
 *   preserved on BOTH branches).
 * `condition` false → the CURRENT monolith link, unchanged.
 *
 * The condition ANDs: `orchestrator.*` path + cohort flag on + gateway URL set +
 * procedure in the (EMPTY-today) allowlist. Any miss → monolith. Because the
 * allowlist is empty, `condition` is ALWAYS false right now → the gateway branch
 * is never taken → zero behavior change.
 */
function withGatewaySplit({
  monolithUrl,
  headers,
}: {
  monolithUrl: string;
  headers: ReturnType<typeof getHeaders>;
}): TRPCLink<AppRouter> {
  const monolithLink = httpLinkWithLargeQuerySupport({ url: monolithUrl, headers });
  // No gateway URL configured → skip the split entirely (pure monolith link).
  if (!gatewayUrl) return monolithLink;
  // CLIENT-ONLY: the cohort flag lives in a module-scope global (`gatewayRoutingEnabled`),
  // which is per-tab in the browser but SHARED across all concurrent requests on the
  // server. Reading it during SSR would leak one user's cohort to another. So on the
  // server we never route to the gateway — SSR orchestrator calls stay on the monolith.
  // (Same hazard class as the per-request QueryClient note below.)
  if (typeof window === 'undefined') return monolithLink;
  return splitLink({
    condition: (op) =>
      shouldRouteToGateway(op.path, { enabled: gatewayRoutingEnabled, url: gatewayUrl }),
    true: httpLinkWithLargeQuerySupport({ url: gatewayUrl, headers }),
    false: monolithLink,
  });
}

const headers: RequestHeaders = {
  'x-client-version': process.env.version,
  'x-client-date': Date.now().toString(),
  'x-client': 'web',
};

/**
 * Shared QueryClient config. Used by both the per-request server `QueryClient`
 * (created by `@trpc/next` via `queryClientConfig` below) and the singleton
 * browser `QueryClient` returned by `getQueryClient()` for callsites that
 * import `queryClient` directly.
 */
const queryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: Infinity,
    },
  },
};

/**
 * Browser-only QueryClient singleton.
 *
 * IMPORTANT: never construct this at module scope. Doing so on the server
 * means every SSR request shares one `QueryCache`, which only ever grows.
 * A heap snapshot from civitai-dp-prod on 2026-05-14 found 11,962 retained
 * `Query` objects on a single pod traceable to a module-scope `QueryClient`.
 *
 * Callsites that import { queryClient } from this module run only in the
 * browser (mutation `onSuccess` callbacks, event handlers, `useEffect`).
 * Touching this on the server will throw to prevent the leak from coming back.
 */
let browserQueryClient: QueryClient | undefined;
function getBrowserQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    throw new Error(
      '[trpc] queryClient was accessed on the server. Use `useQueryClient()` ' +
        'inside a component, or pass `queryClientConfig` to tRPC so a fresh ' +
        'QueryClient is created per request.'
    );
  }
  if (!browserQueryClient) browserQueryClient = new QueryClient(queryClientConfig);
  return browserQueryClient;
}

/**
 * Proxy preserves the existing `import { queryClient } from '~/utils/trpc'`
 * call sites without forcing them to call a function. Property access is
 * lazy, so the singleton is only created when first touched in the browser.
 */
export const queryClient: QueryClient = new Proxy({} as QueryClient, {
  get(_target, prop, receiver) {
    const client = getBrowserQueryClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

const authedCacheBypassLink: TRPCLink<AppRouter> = () => {
  return ({ next, op }) => {
    const isAuthed = typeof window !== 'undefined' ? window.isAuthed : false;
    const authed = removeEmpty({ authed: isAuthed || undefined });
    // Spreading into an ARRAY input would turn `[x]` into `{ 0: x, authed: true }`
    // and corrupt it (e.g. a mutation typed `z.array(...)`), so array inputs pass
    // through untouched — they just don't get the authed cache-key (fine:
    // mutations aren't cached). Object/undefined inputs keep the existing merge.
    const input = Array.isArray(op.input) ? op.input : { ...(op.input as any), ...authed };

    return next({ ...op, input });
  };
};

/**
 * Get headers for each request
 * @see https://trpc.io/docs/v10/client/headers
 */
function getHeaders(ctx?: NextPageContext) {
  return function () {
    return { ...ctx?.req?.headers, ...headers };
  };
}

export const trpcVanilla: CreateTRPCClient<AppRouter> = createTRPCClient<AppRouter>({
  links: [
    authedCacheBypassLink,
    loggerLink({
      enabled: (opts) =>
        (isDev && env.NEXT_PUBLIC_LOG_TRPC) ||
        (opts.direction === 'down' && opts.result instanceof Error),
    }),
    withGatewaySplit({ monolithUrl: url, headers: getHeaders() }),
  ],
});

export const trpc: CreateTRPCNext<AppRouter, NextPageContext> = createTRPCNext<AppRouter>({
  config(opts) {
    const { ctx } = opts;
    const isClient = typeof window !== 'undefined';

    return {
      // On the browser, reuse the same singleton `QueryClient` that direct
      // `import { queryClient }` callsites read/write — otherwise their
      // `setQueriesData`/`cancelQueries` would target a different cache than
      // the one `useQuery` hooks subscribe to.
      //
      // On the server, omit `queryClient` so `@trpc/next` falls through to
      // `new QueryClient(config.queryClientConfig)` per request — the prior
      // module-scope singleton accumulated 11,962 `Query` objects per pod
      // (heap snapshot, civitai-dp-prod, 2026-05-14).
      ...(isClient ? { queryClient: getBrowserQueryClient() } : { queryClientConfig }),
      links: [
        authedCacheBypassLink,
        loggerLink({
          enabled: (opts) =>
            (isDev && env.NEXT_PUBLIC_LOG_TRPC) ||
            (opts.direction === 'down' && opts.result instanceof Error),
        }),
        withGatewaySplit({
          monolithUrl: isClient ? url : `${env.NEXT_PUBLIC_BASE_URL as string}${url}`,
          headers: getHeaders(ctx),
        }),
        // splitLink({
        //   // do not batch post requests
        //   condition: (op) => (op.type === 'query' ? op.context.skipBatch === true : true),
        //   // when condition is true, use normal request
        //   true: httpLink({ url, headers: getHeaders }),
        //   // when condition is false, use batching
        //   // false: unstable_httpBatchStreamLink({ url, maxURLLength: 2083 }),
        //   false: httpLink({ url, headers: getHeaders }), // Let's disable batching for now
        // }),
      ],
    };
  },
  // v11: `createTRPCNext` requires the transformer at the top level of its options
  // (WithTRPCOptions intersects TransformerOptions). The link carries it too for the
  // actual wire (de)serialization.
  transformer: superjson,
  ssr: false,
});

export const handleTRPCError = (
  error: any,
  message = 'There was an error while performing your request'
) => {
  try {
    // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
    const parsedError = JSON.parse(error.message);
    showErrorNotification({
      title: message,
      error: parsedError,
    });
  } catch (e) {
    // Report old error as is:
    showErrorNotification({
      title: message,
      error: new Error(error.message),
    });
  }
};
