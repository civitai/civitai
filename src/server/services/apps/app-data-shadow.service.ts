/**
 * Shadow reads of App Storage lists through the shared app-data service (`apps/app-data-go`),
 * behind the per-app `app-data-registry-shadow` Flipt flag and `APP_DATA_SHADOW_URL`. The
 * document store's answer is always the one served: after the storage route has answered a list,
 * a sampled fraction of eligible lists is also asked of app-data-go with the same bearer token,
 * registry only, off the response path, and the two answers are compared. Design, eligibility,
 * metrics and the turn-on order: `apps/app-data-go/DESIGN.md`, "P4: the site's shadow read".
 *
 * Why registry only (`X-App-Data-Registry-Only: 1`): app-data-go's fallback IS this route. Without
 * the header, a read the registry cannot answer would read this route again from inside its own
 * read, for the answer this route already holds.
 *
 * What is compared: the multiset of the records' `data`, canonicalised (sorted keys) and hashed.
 * Not the keys: the registry names a record by its record id, the REST list by its key, and the two
 * cannot be matched (DESIGN.md, "Record names"). Not the versions: the registry's `rev` is a digest.
 * Nothing logged or counted carries a key, a value, a user or the token.
 */
import { createHash } from 'node:crypto';
import * as z from 'zod';
import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import {
  recordAppDataComparison,
  recordAppDataRegistryMiss,
  recordAppDataShadow,
  registryMissReason,
  type AppDataComparison,
  type AppDataShadowOutcome,
} from '~/server/prom/app-data-shadow.metrics';
import { sortedKeyJson } from '~/server/registry-adapter/release';
import type { EnforcedManifest } from '~/server/services/apps/doc-store-schema-major';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import { rateLimited } from '~/server/utils/shadow-sampler';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';

/** The header that asks app-data-go for the registry's answer only (its `api.RegistryOnlyHeader`). */
export const APP_DATA_REGISTRY_ONLY_HEADER = 'X-App-Data-Registry-Only';

/** At most this many mismatch log lines per minute per process; the counters count every one. */
export const LOG_LINES_PER_MINUTE = 30;

/** The list parameters app-data-go's whole-collection read answers the same way: a page size only. */
const SHADOWABLE_LIST_PARAMS: ReadonlySet<string> = new Set(['limit']);

/**
 * One list the storage route answered, as the route saw it. `queryKeys` are the list's own query
 * parameters (neither the catch-all's `path` nor `from`).
 */
export type AppDataShadowInput = {
  /** The request's `Authorization` header, sent on as it came. */
  authorization: string | undefined;
  /** The app's own collection: no `from`, or a `from` naming the token's own app. */
  own: boolean;
  /** The published namespace (not a dev or review namespace). */
  published: boolean;
  tokenKind: 'app' | 'dev' | 'hub' | 'review';
  signedIn: boolean;
  visibility: 'private' | 'shared' | undefined;
  queryKeys: readonly string[];
  /** The app block id (`apb_…`): the flag's entity. */
  appBlockId: string;
  /** The app's blockId: the slug app-data-go's path and the collection's schema URN name. */
  blockId: string;
  collection: string;
  /** What the collection's schema major is derived against (`doc-store-schema-major.ts`). */
  head: EnforcedManifest | undefined;
  /** The served answer. */
  served: { items: readonly { data: unknown }[]; nextCursor: string | null };
};

export type AppDataShadowConfig = {
  url: string | undefined;
  sample: number;
  maxInFlight: number;
  timeoutMs: number;
};

export type AppDataShadowLogEntry = {
  appBlockId: string;
  collection: string;
} & AppDataComparison;

export type AppDataShadowDeps = {
  /** The `app-data-registry-shadow` flag for one app. */
  enabled: (appBlockId: string, blockId: string) => Promise<boolean>;
  config: () => AppDataShadowConfig;
  random: () => number;
  fetch: (
    url: string,
    init: { headers: Record<string, string>; timeoutMs: number }
  ) => Promise<Response>;
  /** The collection's current schema major (`resolveSchemaMajor`); null when it has none. */
  major: (args: {
    appBlockId: string;
    head: EnforcedManifest | undefined;
    collection: string;
  }) => Promise<number | null>;
  log: (entry: AppDataShadowLogEntry) => void;
};

// app-data-go's answer (`internal/api` `answer`). `data` is any JSON.
const answerSchema = z.object({
  source: z.enum(['registry', 'rest', 'none']),
  reason: z.string().optional(),
  items: z.array(z.object({ data: z.unknown() })),
});

/** Why a list cannot be shadowed, or null when it can. */
export function shadowIneligibility(
  input: AppDataShadowInput
): 'unsupported_input' | 'incomplete' | null {
  if (
    !input.own ||
    !input.published ||
    (input.tokenKind !== 'app' && input.tokenKind !== 'hub') ||
    !input.signedIn ||
    input.visibility !== 'private' ||
    !input.authorization ||
    input.queryKeys.some((k) => !SHADOWABLE_LIST_PARAMS.has(k))
  ) {
    return 'unsupported_input';
  }
  if (input.served.nextCursor !== null) return 'incomplete';
  return null;
}

const dataHash = (data: unknown) =>
  createHash('sha256')
    .update(sortedKeyJson(data ?? null))
    .digest('hex');

/** The two answers' records, matched by their data as a multiset. */
export function compareRecords(
  rest: readonly { data: unknown }[],
  registry: readonly { data: unknown }[]
): AppDataComparison {
  const left = new Map<string, number>();
  for (const r of rest) {
    const h = dataHash(r.data);
    left.set(h, (left.get(h) ?? 0) + 1);
  }
  let registryOnly = 0;
  for (const r of registry) {
    const h = dataHash(r.data);
    const n = left.get(h) ?? 0;
    if (n > 0) left.set(h, n - 1);
    else registryOnly++;
  }
  let restOnly = 0;
  for (const n of left.values()) restOnly += n;
  return { restCount: rest.length, registryCount: registry.length, restOnly, registryOnly };
}

/** app-data-go's read path for one collection. */
export function appDataReadUrl(base: string, blockId: string, collection: string, major: number) {
  return `${base.replace(/\/+$/, '')}/v1/apps/${encodeURIComponent(
    blockId
  )}/collections/${encodeURIComponent(collection)}/records?major=${major}`;
}

// `outboundFetch`'s deadline rejects with a `TimeoutError` DOMException (an `AbortError` from an
// older runtime). Read by name: a DOMException is not an `Error` on every runtime.
const isTimeout = (err: unknown) =>
  typeof err === 'object' &&
  err !== null &&
  ((err as { name?: unknown }).name === 'TimeoutError' ||
    (err as { name?: unknown }).name === 'AbortError');

/**
 * A shadow with its own in-flight count. `shadow` decides synchronously whether to sample this list
 * and returns the background read's promise when it does (undefined when it does not). It never
 * throws and its promise never rejects, so a caller only `void`s it.
 */
export function createAppDataShadow(deps: AppDataShadowDeps) {
  let inFlight = 0;

  async function run(
    cfg: AppDataShadowConfig & { url: string },
    input: AppDataShadowInput
  ): Promise<AppDataShadowOutcome | undefined> {
    // Off for this app: nothing is asked and nothing is counted.
    if (!(await deps.enabled(input.appBlockId, input.blockId))) return undefined;
    const skip = shadowIneligibility(input);
    if (skip) return skip;
    const major =
      (await withTimeoutFallback(
        deps.major({
          appBlockId: input.appBlockId,
          head: input.head,
          collection: input.collection,
        }),
        cfg.timeoutMs,
        null
      ).catch(() => null)) ?? 1;

    let res: Response;
    try {
      res = await deps.fetch(appDataReadUrl(cfg.url, input.blockId, input.collection, major), {
        headers: {
          accept: 'application/json',
          authorization: input.authorization as string,
          [APP_DATA_REGISTRY_ONLY_HEADER]: '1',
        },
        timeoutMs: cfg.timeoutMs,
      });
    } catch (err) {
      return isTimeout(err) ? 'timeout' : 'error';
    }
    if (!res.ok) return 'error';
    let parsed: z.infer<typeof answerSchema>;
    try {
      const body = answerSchema.safeParse(await res.json());
      if (!body.success) return 'bad_response';
      parsed = body.data;
    } catch (err) {
      return isTimeout(err) ? 'timeout' : 'bad_response';
    }
    // A REST answer means app-data-go did not honour registry-only (an older release): it read this
    // route again, and its answer says nothing about the registry.
    if (parsed.source === 'rest') return 'bad_response';
    if (parsed.source === 'none') {
      // An empty registry answer is not trusted by app-data-go (a refused token streams nothing
      // too); it agrees with an empty REST answer, and is a miss otherwise.
      if (parsed.reason === 'empty' && input.served.items.length === 0) {
        recordAppDataComparison(compareRecords([], []));
        return 'compared';
      }
      recordAppDataRegistryMiss(registryMissReason(parsed.reason));
      return 'registry_miss';
    }
    const comparison = compareRecords(input.served.items, parsed.items);
    recordAppDataComparison(comparison);
    if (comparison.restOnly > 0 || comparison.registryOnly > 0) {
      deps.log({ appBlockId: input.appBlockId, collection: input.collection, ...comparison });
    }
    return 'compared';
  }

  function decide(input: AppDataShadowInput): Promise<void> | undefined {
    const cfg = deps.config();
    if (!cfg.url) return undefined;
    if (!(deps.random() < cfg.sample)) return undefined;
    if (inFlight >= cfg.maxInFlight) {
      recordAppDataShadow('saturated');
      return undefined;
    }
    inFlight++;
    return run({ ...cfg, url: cfg.url }, input)
      .catch((): AppDataShadowOutcome => 'error')
      .then((outcome) => {
        if (outcome) recordAppDataShadow(outcome);
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight--;
      });
  }

  return {
    shadow(input: AppDataShadowInput): Promise<void> | undefined {
      try {
        return decide(input);
      } catch {
        return undefined;
      }
    },
    inFlight: () => inFlight,
  };
}

function readConfig(): AppDataShadowConfig {
  return {
    url: env.APP_DATA_SHADOW_URL,
    sample: env.APP_DATA_SHADOW_SAMPLE,
    maxInFlight: env.APP_DATA_SHADOW_MAX_IN_FLIGHT,
    timeoutMs: env.APP_DATA_SHADOW_TIMEOUT_MS,
  };
}

let processShadow: ReturnType<typeof createAppDataShadow> | undefined;

function getProcessShadow() {
  processShadow ??= createAppDataShadow({
    enabled: (appBlockId, blockId) =>
      isFlipt(FLIPT_FEATURE_FLAGS.APP_DATA_REGISTRY_SHADOW, appBlockId, { blockId }),
    config: readConfig,
    random: Math.random,
    fetch: (url, init) => outboundFetch(url, { ...init, redirect: 'manual' }),
    major: async (args) =>
      (await import('~/server/services/apps/doc-store-schema-major')).resolveSchemaMajor(args),
    // Counts only, and the app and collection (which an app declares in its manifest): never a key,
    // a value, the viewer or the token.
    log: rateLimited(
      (entry: AppDataShadowLogEntry) => {
        void logToAxiom({
          name: 'app-data-shadow-mismatch',
          type: 'info',
          message: 'app data shadow read differs from the REST answer',
          payload: {
            appBlockId: entry.appBlockId,
            collection: entry.collection,
            restCount: entry.restCount,
            registryCount: entry.registryCount,
            restOnly: entry.restOnly,
            registryOnly: entry.registryOnly,
          },
        });
      },
      LOG_LINES_PER_MINUTE,
      Date.now
    ),
  });
  return processShadow;
}

/**
 * Shadow one list the storage route answered (see the module doc). Call it after the response is
 * sent. Returns at once; never throws.
 */
export function shadowAppDataList(input: AppDataShadowInput): void {
  try {
    void getProcessShadow().shadow(input);
  } catch {
    // A shadow never affects the request.
  }
}
