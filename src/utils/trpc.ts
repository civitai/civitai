// src/utils/trpc.ts
import { QueryClient, type QueryClientConfig } from '@tanstack/react-query';
import type { CreateTRPCClient, TRPCLink } from '@trpc/client';
import {
  createTRPCClient,
  httpBatchStreamLink,
  httpLink,
  loggerLink,
  splitLink,
} from '@trpc/client';
import type { CreateTRPCNext } from '@trpc/next';
import { createTRPCNext } from '@trpc/next';
import type { NextPageContext } from 'next';
import superjson from 'superjson';
import type { AppRouter } from '~/server/routers';
import { clientTransformer } from '~/shared/utils/trpc-union-transformer';
import { isDev } from '~/env/other';
import { env } from '~/env/client';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';

type RequestHeaders = {
  'x-client-date': string;
  'x-client': string;
  'x-client-version'?: string;
};

const url = '/api/trpc';

/**
 * ── Two size gates for two different URL limits ─────────────────────────────────────────
 * A tRPC query can leave the browser two ways, each with a DIFFERENT URL ceiling:
 *   1. Batched (`httpBatchStreamLink`) — the batch link hard-caps the whole per-request URL
 *      at `maxURLLength: 2083` and throws "Input is too big for a single dispatch" if ONE op
 *      alone exceeds it. → gated by `isTooLargeToBatch` (tight, ENCODED-precise) below.
 *   2. Non-batched single GET (`httpLinkWithLargeQuerySupport`) — no 2083 cap; the only limit
 *      is HTTP 431 / proxy URL limits (~4000+ chars). → gated by `isLargeQuery` (coarse RAW).
 * Keeping these SEPARATE matters: `isLargeQuery` governs the GET→POST decision on the path
 * EVERY query takes while the `trpcBatching` flag is off, so it must NOT inherit the tight
 * batch budget — doing so would needlessly flip mid-size cacheable GETs to (uncacheable) POST
 * for 100% of live traffic. The tight budget applies ONLY to the batch link.
 */

/**
 * Encoded-URL budget (percent-encoded chars) for a single query's input on the BATCH link.
 * Measured against the ACTUAL wire cost — `encodeURIComponent(JSON.stringify(
 * superjson.serialize(input)))`, the same transform tRPC applies when building the GET URL —
 * NOT a raw-char heuristic. It MUST use the same serializer the client actually writes with
 * (the CLIENT stays superjson-write in Phase 2 — the per-pool devalue flip is SERVER-only,
 * so the browser bundle keeps writing superjson via `input.serialize`); sizing with a
 * different serializer would let the GET/POST batching decision drift from the real wire
 * length. Sits ~280 under the batch link's
 * `maxURLLength: 2083` to absorb the path (`/api/trpc/<proc>`) + `?batch=1&input={"0":…}`
 * wrapper overhead, so a single op can never overflow the batched GET regardless of how
 * punctuation-dense its JSON is.
 *
 * Why encoded, not raw: JSON near the limit is structurally dense (`{}",:[]`, each → %XX), so
 * the encoded URL runs ~1.75–1.9× the raw JSON — not the ~1.4× a fixed factor assumes. A raw
 * threshold that looks safe (e.g. 1400) still lets a ~12–14-resource whatIf payload stay
 * batched yet overflow 2083 (the exact #2962 crash). Measuring the encoded length removes the
 * guess and can't drift with payload composition.
 */
const URL_INPUT_BUDGET = 1800;

/**
 * Whether a query's input is too large to safely ride the BATCH link (whose single-op URL is
 * hard-capped at `maxURLLength: 2083`). Excludes such a query from batching (see `shouldBatch`)
 * so it can never trip the "Input is too big for a single dispatch" throw.
 *
 * Measures the ACTUAL encoded wire cost — the exact `encodeURIComponent(JSON.stringify(
 * superjson.serialize(input)))` tRPC builds the GET URL from — against `URL_INPUT_BUDGET`. Uses
 * the SAME serializer the client links write with (the client stays superjson-write in Phase 2),
 * so the sizer can't drift from the real URL. No length-based short-circuit: a byte/char-count proxy underestimates the
 * encoded length in the unsafe direction (a small-count input can encode large — the serializer
 * expands special types, and `encodeURIComponent` expands one non-ASCII UTF-16 unit to up to 9
 * chars, e.g. `中` → `%E4%B8%AD`), which twice let an overflowing op stay batched. `serialize`
 * already runs unconditionally on the write path, so the encode walk is a marginal added cost,
 * not worth the hole.
 */
export function isTooLargeToBatch(op: { type: string; input: unknown }) {
  if (op.type !== 'query' || op.input == null) return false;
  try {
    return encodeURIComponent(JSON.stringify(superjson.serialize(op.input))).length > URL_INPUT_BUDGET;
  } catch {
    return false;
  }
}

/**
 * Raw-input threshold for the NON-BATCHED single GET. That path has no 2083 batch cap — the
 * only ceiling is the server/proxy URL limit (HTTP 431; Node ~16KB, nginx/Traefik default 8KB),
 * which is far looser than the batch cap, so a coarse raw-char heuristic is sufficient here.
 * NOTE this bounds RAW input, not the encoded URL: a punctuation-dense raw-2500 input can encode
 * to a multi-KB GET URL — still well under those limits, but do NOT read 2500 as "≈4KB URL".
 * Held at the long-standing 2500 so this path's GET→POST (and therefore edge-cacheability)
 * behaviour is UNCHANGED from before batching shipped: the tight encoded batch budget governs
 * the batch link ONLY, never 100% of live GET traffic.
 */
const MAX_GET_INPUT_LENGTH = 2500;

/**
 * Whether a query's input is large enough that carrying it in a NON-BATCHED GET URL would risk
 * HTTP 431 / proxy URL limits. Such queries are routed through tRPC's native
 * `methodOverride: 'POST'`, which moves the input into the request body. Requires
 * `allowMethodOverride: true` on the server adapter — see `src/pages/api/trpc/[trpc].ts`.
 */
export function isLargeQuery(op: { type: string; input: unknown }) {
  if (op.type !== 'query' || op.input == null) return false;
  try {
    return JSON.stringify(op.input).length > MAX_GET_INPUT_LENGTH;
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
    true: httpLink({ transformer: clientTransformer, url, methodOverride: 'POST', headers }),
    false: httpLink({ transformer: clientTransformer, url, headers }),
  });
}

/**
 * Module-scoped, flag-driven batch toggle. Default OFF so batching is dark until the
 * `trpcBatching` feature flag ramps. Set from `FeatureFlagsProvider` once the per-user
 * flag overlay resolves in the browser. Kept as a mutable module flag (not React state)
 * because the tRPC terminating link is built once at module init and cannot read a hook;
 * the `splitLink` condition re-reads this per operation, so a later flip takes effect on
 * subsequent queries without rebuilding the client.
 */
let trpcBatchingEnabled = false;
export function setTrpcBatchingEnabled(enabled: boolean) {
  trpcBatchingEnabled = enabled;
}
/**
 * Whether tRPC request batching is active for THIS client (the `trpcBatching` flag
 * resolved on for this user). Read by both `shouldBatch` (link routing) and the
 * `QueryClient` `retry` policy, so retry behavior stays coupled to the batch cohort.
 */
export function getTrpcBatchingEnabled() {
  return trpcBatchingEnabled;
}
// Back-compat alias used by existing unit tests.
export const __getTrpcBatchingEnabled = getTrpcBatchingEnabled;

/**
 * True ONLY when we are definitively in an authenticated browser session.
 * `window.isAuthed` is set by `CivitaiSessionProvider` AFTER hydration, so on the server
 * and during early hydration this is `false` — the SAFE direction: anonymous + unknown
 * ⇒ do NOT batch, so anonymous edge-cacheable tRPC GETs stay unbatched (no `?batch`
 * param) and remain CF-cacheable.
 */
function isAuthedBrowser() {
  return typeof window !== 'undefined' && window.isAuthed === true;
}

/**
 * tRPC procedure paths (`<routerKey>.<procedure>`) that are EDGE-CACHEABLE for
 * AUTHENTICATED sessions and therefore must NEVER be batched — batching appends
 * `?batch=1`, which `edgeCacheIt` (`src/server/middleware.trpc.ts`) refuses to cache, so
 * batching one of these would trade an authed CF edge-hit for extra api-pool load (the
 * opposite of the goal).
 *
 * IMPORTANT — this is the FULL set of procedures that apply `edgeCacheIt` and do NOT opt
 * back out for authed sessions via `noEdgeCache({ authedOnly: true })` (or a blanket
 * `noEdgeCache()`). NB: `createContext` seeds `edgeTTL: 0` for logged-in users, but
 * `edgeCacheIt` OVERWRITES it with a positive TTL (it only honors the `?batch` bail and
 * `ctx.cache.canCache`), so these responses ARE cacheable for authed users today.
 *
 * 🔴 Keep this in sync with the routers. `trpc-batching.test.ts` re-derives this set by
 * parsing every `*.router.ts` and FAILS if it drifts — so adding a new `edgeCacheIt`
 * procedure without listing it here (or without an authed `noEdgeCache`) breaks CI rather
 * than silently starting to batch (and de-cache) it.
 */
export const CACHEABLE_PROCEDURES: ReadonlySet<string> = new Set([
  'article.getCivitaiNews',
  'bug.getLatest',
  'changelog.getLatest',
  'event.getData',
  'event.getDonors',
  'event.getPartners',
  'event.getRewards',
  'event.getTeamScoreHistory',
  'event.getTeamScores',
  'generation.checkResourcesCoverage',
  'generation.getStatus',
  'homeBlock.getHomeBlock',
  'image.get404Images',
  'image.getGenerationData',
  'image.getResources',
  'model.getAll',
  'modelFile.getOptions',
  'nowPayments.getBuzzConversionRate',
  'nowPayments.getMinAmount',
  'nowPayments.getSupportedCurrencies',
  'system.getCreationBlockedTags',
  'system.getDbKV',
  'system.getLiveNow',
  'tag.getHomeExcluded',
  'technique.getAll',
  'tool.getAll',
  'training.getStatus',
  'user.getCreator',
]);

/**
 * Route an operation to the streaming batch link only when ALL hold:
 *  - it's a `query` (mutations stay standalone — matches the historical link, and keeps
 *    the large-mutation POST path intact),
 *  - the `trpcBatching` flag is on for this user,
 *  - we're in an authenticated browser (see `isAuthedBrowser` — anon stays cacheable),
 *  - the procedure is NOT edge-cacheable for authed sessions (see `CACHEABLE_PROCEDURES`),
 *  - the caller didn't opt out via `context.skipBatch === true`,
 *  - its encoded input fits the batch link's URL cap (`isTooLargeToBatch` — otherwise it
 *    would trip "Input is too big for a single dispatch"; excluded ops fall to the
 *    non-batched link, which sends them as GET or POST per `isLargeQuery`).
 */
export function shouldBatch(op: {
  type: string;
  path: string;
  input: unknown;
  context: Record<string, unknown>;
}) {
  return (
    op.type === 'query' &&
    trpcBatchingEnabled &&
    isAuthedBrowser() &&
    !CACHEABLE_PROCEDURES.has(op.path) &&
    op.context.skipBatch !== true &&
    !isTooLargeToBatch(op)
  );
}

/**
 * Shared terminating link. Authenticated-browser queries (flag-gated) go out batched via
 * `httpBatchStreamLink` (results stream as they resolve, so the fastest query in a batch
 * isn't blocked by the slowest); everything else — anonymous traffic, mutations, large
 * queries, and `skipBatch` opt-outs — falls through to the unbatched large-query-aware
 * path, preserving CF edge-cache for anon GETs and the `methodOverride: 'POST'` route.
 */
function terminatingLink({
  url,
  headers,
}: {
  url: string;
  headers: ReturnType<typeof getHeaders>;
}): TRPCLink<AppRouter> {
  return splitLink({
    condition: shouldBatch,
    true: httpBatchStreamLink({ transformer: clientTransformer, url, headers, maxURLLength: 2083 }),
    false: httpLinkWithLargeQuerySupport({ url, headers }),
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
/**
 * Query retry policy.
 *
 * Dark path (batching flag OFF): `failureCount < 1` == exactly one retry — byte-for-byte
 * the prior `retry: 1` behavior for every non-batched user.
 *
 * Batch cohort (flag ON): 0 retries. A batch transport failure (e.g. a 5xx on the single
 * coalesced HTTP request) fails ALL N queries in that batch at once; with `retry: 1` that
 * would fire N simultaneous retries — a thundering herd on the event-loop-bound api pool
 * during the exact incident the retry was meant to smooth. Suppressing retries for the
 * batch cohort keeps a batch failure to a single in-flight request. Reverts with the flag.
 *
 * Scope: `defaultOptions.queries` only — mutations (which never batch) keep React Query's
 * own default (0 query-retries), so this does not change mutation behavior.
 */
export function queryRetry(failureCount: number, _error: unknown): boolean {
  if (getTrpcBatchingEnabled()) return false;
  return failureCount < 1;
}

const queryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: queryRetry,
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
    terminatingLink({ url, headers: getHeaders() }),
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
        terminatingLink({
          url: isClient ? url : `${env.NEXT_PUBLIC_BASE_URL as string}${url}`,
          headers: getHeaders(ctx),
        }),
      ],
    };
  },
  // v11: `createTRPCNext` requires the transformer at the top level of its options
  // (WithTRPCOptions intersects TransformerOptions). The link carries it too for the
  // actual wire (de)serialization. Phase 2 CLIENT: union READ, superjson WRITE (the
  // per-pool devalue write flip is SERVER-only — see trpc-union-transformer.ts).
  transformer: clientTransformer,
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
