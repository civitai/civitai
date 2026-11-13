import {
  FliptClient,
  type ErrorStrategy,
  type NodeFliptClient as NodeFliptClientClass,
} from '@flipt-io/flipt-client-js';
import { fliptCacheKeySuffix, TtlCache, type TtlCacheStats } from './cache';
import { loadFliptConnection, loadFliptTuning, type FliptConfig, type FliptTuning } from './env';
import {
  createLiveFetcher,
  createSnapshotFetcher,
  type FliptSnapshot,
  type FliptSnapshotStore,
} from './snapshot';

/**
 * The client as it exists at runtime here. The SDK (0.2.0) resolves to its `node` build under
 * Node, and that build's class has the config poller (a `setInterval` started by `init` when
 * `updateInterval` is set) and `close()`, which clears it. Its declared `FliptClient` type is the
 * BROWSER class, which has neither, so the type is taken from the SDK's own `NodeFliptClient`
 * declaration (a type: the node build exports the class as `FliptClient`).
 */
export type FliptNodeClient = InstanceType<typeof NodeFliptClientClass>;

/** `FliptClient.init`, typed as the node build it resolves to. */
const initClient = (options: Parameters<typeof FliptClient.init>[0]) =>
  FliptClient.init(options) as unknown as Promise<FliptNodeClient>;

// `ErrorStrategy.Fallback`, spelled as its value so this module needs no runtime value from the
// SDK beyond `FliptClient` (apps fake the SDK with just that class).
const FALLBACK = 'fallback' as ErrorStrategy;

export type FliptLogFn = (message: string, ...args: unknown[]) => void;

/**
 * Tuning is resolved when the instance is built; connection config may still be pending (read from
 * env on first evaluation), so it's optional here.
 */
export type FliptResolvedConfig = FliptTuning & Partial<Pick<FliptConfig, 'url' | 'clientToken'>>;

export type FliptOptions = Partial<FliptConfig> & {
  /**
   * Flags exempt from the eval cache: incident kill-switches where an operator expects a flip to
   * take effect ASAP and the eval is either rare (cold path) or the extra staleness isn't worth
   * the CPU saved. App-owned, because which flags are kill-switches is an app concern.
   */
  cacheBypass?: Iterable<string>;
  /** Init failures. INJECTED so this package owns no logging transport. Defaults to console.error. */
  onInitError?: (error: Error) => void;
  /** Per-evaluation engine errors (incl. "flag not found"). Defaults to console.error. */
  onEvalError?: (error: unknown, flag: string) => void;
  /** Startup/diagnostic lines. Defaults to console.log. */
  log?: FliptLogFn;
  /**
   * Last-known flag state, shared between processes. With it, a process that cannot reach Flipt
   * at startup evaluates from the newest stored snapshot (no older than `snapshotMaxAgeMs`) instead
   * of answering `false` for every flag, and a process with live state keeps the stored copy current.
   * While Flipt stays unreachable, each failed retry reloads the store and switches to a newer
   * snapshot when one was saved. `snapshotMaxAgeMs` is the admission limit for the FIRST seed only:
   * a seeded snapshot is never dropped for age, so a fleet-wide Flipt outage longer than the limit
   * does not turn every seeded process's flags off at once.
   */
  snapshotStore?: FliptSnapshotStore;
};

export type FliptVariantDetail = {
  match: boolean;
  variantKey: string | null;
  segmentKeys: readonly string[];
};

export const LOCAL_OVERRIDE_SEGMENT = 'local-override';

export type FliptFeatureFlags = {
  /**
   * Boolean evaluation honoring local overrides. `false` when the flag is unknown, or when Flipt
   * has been unreachable since this process started and no usable snapshot was stored.
   */
  isEnabled(flag: string, entityId?: string, context?: Record<string, string>): Promise<boolean>;
  /**
   * Boolean evaluation that IGNORES local overrides — for call sites that must reflect real Flipt
   * state (e.g. verifying a rollout) rather than a developer's `.env`.
   */
  getBoolean(flag: string, entityId?: string, context?: Record<string, string>): Promise<boolean>;
  /** Variant evaluation honoring local overrides. `null` when there's no match or Flipt is unreachable. */
  getVariant(
    flag: string,
    entityId?: string,
    context?: Record<string, string>
  ): Promise<string | null>;
  /**
   * Synchronous variant evaluation with the segments that matched, so a caller can tell a pinned
   * segment from the general rollout. `null` until the client has initialized, or when the
   * evaluation throws (an unknown flag key); `match: false` when the flag is disabled or no rule
   * matched.
   */
  getVariantDetailSync(
    flag: string,
    entityId?: string,
    context?: Record<string, string>
  ): FliptVariantDetail | null;
  /**
   * Synchronous evaluation. Returns `boolean` if Flipt is ready, or `null` if the client hasn't
   * initialized yet (caller should fall back).
   */
  isEnabledSync(flag: string, entityId?: string, context?: Record<string, string>): boolean | null;
  /** Warm the client so `isEnabledSync` can answer. Safe to call repeatedly. */
  ensureInitialized(): Promise<void>;
  /**
   * The underlying client — the live one, else the one seeded from a stored snapshot — or `null`.
   * Escape hatch for raw SDK calls.
   */
  getClientSync(): FliptNodeClient | null;
  /**
   * Cumulative eval-cache counters for both caches. Pure read; safe to call on a
   * scrape interval. See `TtlCacheStats` — `expiredMisses` vs `rotations` is what
   * separates a TTL-bound cache (raise the TTL) from a capacity-bound one (raise
   * `maxEntries`); a bare hit rate cannot tell those apart, and they have opposite
   * remedies.
   */
  getCacheStats(): { boolean: TtlCacheStats; variant: TtlCacheStats };
  /**
   * Set (or replace) the last-known snapshot store after construction — for an app whose storage
   * client must not be imported by the module that builds this instance. Read when it is needed
   * (a failed init, a live fetch), so registering it before the first init FAILS is enough.
   */
  setSnapshotStore(store: FliptSnapshotStore | undefined): void;
  config: FliptResolvedConfig;
};

/**
 * Build a Flipt feature-flag accessor. `url`/`clientToken` come from `FLIPT_URL` /
 * `FLIPT_FETCHER_SECRET` unless passed in — an app whose own env module already validates them
 * (the monolith) passes them and this package never reads process.env for them.
 *
 * One instance owns one wasm client + its eval caches; create it once per app and share it.
 */
export function createFliptClient(options: FliptOptions = {}): FliptFeatureFlags {
  const {
    cacheBypass,
    onInitError = (error: Error) => console.error('[flipt] init error:', error),
    onEvalError = (error: unknown) => console.error('[flipt] evaluation error:', error),
    log = console.log,
    snapshotStore: initialSnapshotStore,
    ...configOverrides
  } = options;
  let snapshotStore = initialSnapshotStore;

  const config: FliptResolvedConfig = { ...loadFliptTuning(), ...configOverrides };
  const bypass = new Set(cacheBypass ?? []);
  const { localOverrides } = config;

  log(`[flipt] eval cache TTL: ${config.evalCacheTtlMs}ms (0 = disabled)`);

  const boolCache = new TtlCache<boolean>(config.evalCacheTtlMs, config.evalCacheMaxEntries);
  const variantCache = new TtlCache<FliptVariantDetail>(
    config.evalCacheTtlMs,
    config.evalCacheMaxEntries
  );

  // `instance` is the live client: it polls Flipt. `seeded` evaluates a stored snapshot and never
  // polls; it serves until a live client exists. `seededSavedAt` is its snapshot's `savedAt`: each
  // failed retry reloads the store and swaps in a snapshot saved after it.
  let instance: FliptNodeClient | null = null;
  let seeded: FliptNodeClient | null = null;
  let seededSavedAt = 0;
  let initializing: Promise<FliptNodeClient | null> | null = null;
  let lastFailureTime = 0;
  // Whether any init attempt has finished. Only the FIRST attempt is waited on by callers (a cold
  // process should not answer before it has tried once); every retry after a failure runs in the
  // background, and callers keep the seeded state or the fail-closed default meanwhile.
  let attempted = false;

  function dropSeeded() {
    const old = seeded;
    seeded = null;
    seededSavedAt = 0;
    try {
      old?.close();
    } catch (e) {
      log('[flipt] could not close the snapshot-seeded client:', e);
    }
  }

  const current = () => instance ?? seeded;

  // The newest snapshot this process holds from live fetches, and when it last saved one.
  let liveData: unknown;
  let liveEtag: string | null = null;
  let lastSaveAt = 0;

  function saveSnapshot(changed: boolean) {
    const store = snapshotStore;
    // Off (the default) means no writes either, not just no seeding.
    if (!store || config.snapshotMaxAgeMs <= 0 || liveData === undefined) return;
    const now = Date.now();
    if (!changed && now - lastSaveAt < config.snapshotSaveIntervalMs) return;
    lastSaveAt = now;
    const snapshot: FliptSnapshot = { savedAt: now, etag: liveEtag, data: liveData };
    store.save(snapshot, changed).catch((e) => log('[flipt] snapshot save failed:', e));
  }

  // Runs after every failed init attempt, not just the first, so a process that alone cannot reach
  // Flipt follows the snapshots its healthy siblings keep saving instead of evaluating its boot-time
  // one forever. A stored snapshot no newer than the seeded one changes nothing. The age limit
  // admits the first seed only: once seeded, a newer snapshot is always an improvement, and the
  // seeded one is never dropped for age (a fleet-wide outage past the limit must not flip every
  // seeded process's flags off together while live processes keep theirs).
  async function seedFromSnapshot(): Promise<void> {
    const store = snapshotStore;
    if (!store || config.snapshotMaxAgeMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([
        store.load(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Flipt snapshot load timeout')),
            config.snapshotLoadTimeoutMs
          );
        }),
      ]);
      if (!snapshot) {
        if (!seeded) {
          log('[flipt] Flipt unreachable and no stored snapshot; flags evaluate to their defaults');
        }
        return;
      }
      if (seeded && snapshot.savedAt <= seededSavedAt) return;
      const ageMs = Date.now() - snapshot.savedAt;
      if (!seeded && ageMs > config.snapshotMaxAgeMs) {
        log(
          `[flipt] Flipt unreachable; stored snapshot is ${Math.round(ageMs / 1000)}s old, over ` +
            `the ${Math.round(config.snapshotMaxAgeMs / 1000)}s limit — not used`
        );
        return;
      }
      const next = await initClient({
        environment: config.environment,
        fetcher: createSnapshotFetcher(snapshot.data),
        errorStrategy: FALLBACK,
      });
      const replacing = seeded !== null;
      if (replacing) dropSeeded();
      seeded = next;
      seededSavedAt = snapshot.savedAt;
      log(
        `[flipt] Flipt unreachable; evaluating from ${
          replacing ? 'a newer' : 'the'
        } snapshot saved ` +
          `${new Date(snapshot.savedAt).toISOString()} (${Math.round(ageMs / 1000)}s old)`
      );
    } catch (e) {
      log('[flipt] snapshot seed failed:', e);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function startInit(): Promise<FliptNodeClient | null> {
    if (initializing) return initializing;

    initializing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Resolved here, not at construction: a missing FLIPT_URL must degrade this instance to
        // fail-closed, not throw out of the import that built it.
        const connection =
          config.url && config.clientToken
            ? { url: config.url, clientToken: config.clientToken }
            : loadFliptConnection();

        const fetcher = createLiveFetcher({
          url: connection.url,
          clientToken: connection.clientToken,
          environment: config.environment,
          timeoutMs: config.fetchTimeoutMs,
          onSnapshot: (data, etag) => {
            liveData = data;
            liveEtag = etag;
            saveSnapshot(true);
          },
          onConfirmed: () => saveSnapshot(false),
        });

        let abandoned = false;
        const initPromise = (async () => {
          const client = await initClient({
            environment: config.environment,
            url: connection.url,
            authentication: { clientToken: connection.clientToken },
            updateInterval: config.updateIntervalSeconds,
            fetcher,
            // Keep serving the last state when a poll fails. 0.2.0 already behaves this way when
            // the option is unset; set so an SDK upgrade cannot switch it to throwing.
            errorStrategy: FALLBACK,
          });
          await client.refresh();
          return client;
        })();

        // A client that arrives after the timeout won is never used, and its poller would run for
        // the life of the process. Close it.
        initPromise.then(
          (late) => {
            if (!abandoned) return;
            try {
              late.close();
            } catch (e) {
              log('[flipt] could not close the client that arrived after the init timeout:', e);
            }
          },
          () => null
        );

        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abandoned = true;
            reject(new Error('Flipt init timeout'));
          }, config.initTimeoutMs);
        });

        instance = await Promise.race([initPromise, timeoutPromise]);
        if (seeded) {
          log('[flipt] live flag state loaded; no longer evaluating from the snapshot');
          dropSeeded();
        }
        return instance;
      } catch (e) {
        onInitError(e as Error);
        instance = null;
        lastFailureTime = Date.now();
        await seedFromSnapshot();
        return current();
      } finally {
        if (timer) clearTimeout(timer);
        attempted = true;
        initializing = null;
      }
    })();

    return initializing;
  }

  // The context part of the cache key, built once per FROZEN context (as `buildFliptContext`
  // returns) instead of once per flag: a caller evaluating every flag for one user passes the same
  // object each time. Frozen only, because a frozen object cannot change after its key part was
  // built; any other context builds it on every call, as before. Weak, so it lives as long as the
  // context does (one request).
  const keySuffixes = new WeakMap<object, { entityId: string; suffix: string }>();

  function evalCacheKey(flag: string, entityId: string, context: Record<string, string>): string {
    if (!Object.isFrozen(context)) return flag + fliptCacheKeySuffix(entityId, context);
    const memo = keySuffixes.get(context);
    if (memo && memo.entityId === entityId) return flag + memo.suffix;
    const suffix = fliptCacheKeySuffix(entityId, context);
    keySuffixes.set(context, { entityId, suffix });
    return flag + suffix;
  }

  async function getInstance(): Promise<FliptNodeClient | null> {
    if (instance) return instance;

    // Circuit breaker: no new attempt during the cooldown after a failure.
    if (!initializing && Date.now() - lastFailureTime >= config.failureCooldownMs) startInit();
    if (initializing && !attempted) return initializing;
    return current();
  }

  // Evaluate against the wasm engine, memoized. Throws on engine error so callers keep their
  // fallback; only successful evaluations are cached.
  //
  // Per-request wasm `evaluateBoolean`/`evaluateVariant` calls showed up as a top-10 CPU frame
  // under load (~1500 req/s on a single JS thread). The engine result for a given
  // (flag, entityId, context) is stable between config refreshes, so a short in-process TTL cache
  // collapses the wasm call rate.
  function evalBooleanCached(
    client: FliptNodeClient,
    flag: string,
    entityId: string,
    context: Record<string, string>
  ): boolean {
    if (bypass.has(flag)) {
      return client.evaluateBoolean({ flagKey: flag, entityId, context }).enabled;
    }
    const now = Date.now();
    const key = evalCacheKey(flag, entityId, context);
    const cached = boolCache.get(key, now);
    if (cached.hit) return cached.value as boolean;
    const { enabled } = client.evaluateBoolean({ flagKey: flag, entityId, context });
    boolCache.set(key, enabled, now);
    return enabled;
  }

  function evaluateVariantDetail(
    client: FliptNodeClient,
    flag: string,
    entityId: string,
    context: Record<string, string>
  ): FliptVariantDetail {
    const evaluation = client.evaluateVariant({ flagKey: flag, entityId, context });
    return Object.freeze({
      match: evaluation.match,
      variantKey: evaluation.match ? evaluation.variantKey : null,
      segmentKeys: Object.freeze([...(evaluation.segmentKeys ?? [])]),
    });
  }

  function evalVariantCached(
    client: FliptNodeClient,
    flag: string,
    entityId: string,
    context: Record<string, string>
  ): FliptVariantDetail {
    if (bypass.has(flag)) return evaluateVariantDetail(client, flag, entityId, context);
    const now = Date.now();
    const key = evalCacheKey(flag, entityId, context);
    const cached = variantCache.get(key, now);
    if (cached.hit) return cached.value as FliptVariantDetail;
    const result = evaluateVariantDetail(client, flag, entityId, context);
    variantCache.set(key, result, now);
    return result;
  }

  return {
    config,

    getClientSync: () => current(),

    async ensureInitialized() {
      await getInstance();
    },

    async isEnabled(flag, entityId = 'global', context = {}) {
      if (localOverrides[flag] !== undefined) return localOverrides[flag] === 'on';
      const client = await getInstance();
      if (!client) return false;
      try {
        return evalBooleanCached(client, flag, entityId, context);
      } catch (e) {
        onEvalError(e, flag);
        return false;
      }
    },

    async getBoolean(flag, entityId = 'global', context = {}) {
      const client = await getInstance();
      if (!client) return false;
      try {
        return evalBooleanCached(client, flag, entityId, context);
      } catch {
        return false;
      }
    },

    async getVariant(flag, entityId = 'global', context = {}) {
      if (localOverrides[flag] !== undefined) return localOverrides[flag];
      const client = await getInstance();
      if (!client) return null;
      try {
        return evalVariantCached(client, flag, entityId, context).variantKey;
      } catch (e) {
        onEvalError(e, flag);
        return null;
      }
    },

    getVariantDetailSync(flag, entityId = 'global', context = {}) {
      const override = localOverrides[flag];
      if (override !== undefined) {
        return { match: true, variantKey: override, segmentKeys: [LOCAL_OVERRIDE_SEGMENT] };
      }
      const client = current();
      if (!client) return null;
      try {
        return evalVariantCached(client, flag, entityId, context);
      } catch (e) {
        onEvalError(e, flag);
        return null;
      }
    },

    isEnabledSync(flag, entityId = 'global', context = {}) {
      if (localOverrides[flag] !== undefined) return localOverrides[flag] === 'on';
      const client = current();
      if (!client) return null;
      try {
        return evalBooleanCached(client, flag, entityId, context);
      } catch {
        // Swallow eval errors (incl. "flag not found"); caller falls back to null
        return null;
      }
    },
    getCacheStats() {
      return { boolean: boolCache.stats(), variant: variantCache.stats() };
    },
    setSnapshotStore(store) {
      snapshotStore = store;
    },
  };
}
