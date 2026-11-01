import { FliptClient } from '@flipt-io/flipt-client-js';
import { fliptCacheKeySuffix, TtlCache, type TtlCacheStats } from './cache';
import { loadFliptConnection, loadFliptTuning, type FliptConfig, type FliptTuning } from './env';

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
   * Key of a boolean flag that, when ON, lets a boolean evaluation of a flag with NO rollouts in
   * the current snapshot return that flag's `enabled` without calling the wasm engine — which is
   * exactly what the engine returns for such a flag, for every entity and context. Read by this
   * client straight from the engine (entityId 'global', no context, local overrides honoured), at
   * most once per 5s; unknown or unreadable reads as OFF. Omitted: never skips the engine.
   */
  noRolloutFastPathSwitch?: string;
};

// `prepareFliptContext` stores the cache-key suffix under this symbol. Non-enumerable, so
// `Object.keys`, spreads, `for…in` (the SDK's request serializer) and JSON never see it.
const PREPARED_KEY = Symbol('fliptPreparedCacheKey');
type PreparedContext = Readonly<Record<string, string>> & {
  readonly [PREPARED_KEY]?: { entityId: string; suffix: string };
};

/**
 * A frozen copy of `context` carrying its eval-cache key suffix for `entityId`, built once. Pass
 * it to every evaluation of one subject (e.g. a full feature-flag compute) to skip re-sorting and
 * re-encoding the context per flag. The key is the same string `fliptCacheKey` builds, so it
 * shares cache entries with unprepared calls; it is used only when the call's `entityId` matches,
 * and the copy is frozen, so it cannot drift from the context it describes.
 */
export function prepareFliptContext(
  entityId: string,
  context: Record<string, string>
): Readonly<Record<string, string>> {
  const copy: Record<string, string> = { ...context };
  Object.defineProperty(copy, PREPARED_KEY, {
    value: { entityId, suffix: fliptCacheKeySuffix(entityId, copy) },
    enumerable: false,
  });
  return Object.freeze(copy);
}

function evalCacheKey(flag: string, entityId: string, context: PreparedContext): string {
  const prepared = context[PREPARED_KEY];
  if (prepared && prepared.entityId === entityId) return flag + prepared.suffix;
  return flag + fliptCacheKeySuffix(entityId, context);
}

const NO_ROLLOUT_SWITCH_REFRESH_MS = 5_000;

/**
 * What one engine snapshot says about its flags, built at most once per snapshot (lazily, on the
 * first evaluation after it is applied) and dropped when the next one is applied.
 */
type SnapshotView = {
  /** Flag keys the ENGINE lists for this snapshot; null if it could not list them. */
  keys: Set<string> | null;
  /** Boolean evaluations that failed for a key not in `keys`: the engine's own error, rethrown. */
  missing: Map<string, unknown>;
  /**
   * Boolean flags whose evaluation cannot depend on entity or context: BOOLEAN type, no rollouts
   * (`rollouts` absent, null or []), so the engine returns `enabled`. Rules are not read by a
   * boolean evaluation. Null when the raw snapshot was not captured.
   */
  constants: Map<string, boolean> | null;
};

type RawSnapshotFlag = { key?: unknown; enabled?: unknown; rollouts?: unknown };

function buildConstants(
  listed: { key: string; enabled: boolean; type: string }[],
  raw: unknown
): Map<string, boolean> | null {
  const rawFlags = (raw as { flags?: unknown } | null | undefined)?.flags;
  if (!Array.isArray(rawFlags)) return null;
  const byKey = new Map<string, RawSnapshotFlag | null>();
  for (const f of rawFlags as RawSnapshotFlag[]) {
    if (!f || typeof f.key !== 'string') continue;
    // A key listed twice is ambiguous about which copy the engine kept: never fast-path it.
    byKey.set(f.key, byKey.has(f.key) ? null : f);
  }
  const constants = new Map<string, boolean>();
  for (const flag of listed) {
    // Type and `enabled` come from the engine's own listing; the raw snapshot only answers
    // "does it have rollouts", and must agree with the engine on `enabled`.
    if (flag.type !== 'BOOLEAN_FLAG_TYPE') continue;
    const r = byKey.get(flag.key);
    if (!r || r.enabled !== flag.enabled) continue;
    const noRollouts =
      r.rollouts === undefined ||
      r.rollouts === null ||
      (Array.isArray(r.rollouts) && r.rollouts.length === 0);
    if (noRollouts) constants.set(flag.key, flag.enabled);
  }
  return constants;
}

export type FliptFeatureFlags = {
  /** Boolean evaluation honoring local overrides. `false` when Flipt is unreachable or the flag is unknown. */
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
   * Synchronous evaluation. Returns `boolean` if Flipt is ready, or `null` if the client hasn't
   * initialized yet (caller should fall back).
   */
  isEnabledSync(flag: string, entityId?: string, context?: Record<string, string>): boolean | null;
  /** Warm the client so `isEnabledSync` can answer. Safe to call repeatedly. */
  ensureInitialized(): Promise<void>;
  /** The underlying client if initialized, else `null`. Escape hatch for raw SDK calls. */
  getClientSync(): FliptClient | null;
  /**
   * Cumulative eval-cache counters for both caches. Pure read; safe to call on a
   * scrape interval. See `TtlCacheStats` — `expiredMisses` vs `rotations` is what
   * separates a TTL-bound cache (raise the TTL) from a capacity-bound one (raise
   * `maxEntries`); a bare hit rate cannot tell those apart, and they have opposite
   * remedies.
   */
  getCacheStats(): { boolean: TtlCacheStats; variant: TtlCacheStats };
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
    noRolloutFastPathSwitch,
    ...configOverrides
  } = options;

  const config: FliptResolvedConfig = { ...loadFliptTuning(), ...configOverrides };
  const bypass = new Set(cacheBypass ?? []);
  const { localOverrides } = config;

  log(`[flipt] eval cache TTL: ${config.evalCacheTtlMs}ms (0 = disabled)`);

  const boolCache = new TtlCache<boolean>(config.evalCacheTtlMs, config.evalCacheMaxEntries);
  const variantCache = new TtlCache<string | null>(
    config.evalCacheTtlMs,
    config.evalCacheMaxEntries
  );

  let instance: FliptClient | null = null;
  let initializing: Promise<FliptClient | null> | null = null;
  let lastFailureTime = 0;

  // Per-snapshot state, per SDK client. Only a client whose engine `trackSnapshots` hooked gets a
  // view, so a snapshot change can never leave a stale one in place; any other client takes the
  // engine path exactly as before. Keyed by client because an init that loses its timeout race
  // leaves an orphaned client whose own refresh timer keeps applying snapshots.
  const tracked = new WeakMap<FliptClient, { raw: unknown; view: SnapshotView | null }>();
  let noRolloutSwitchValue = false;
  let noRolloutSwitchExpiresAt = Number.NEGATIVE_INFINITY;

  // Hook the engine's `snapshot()` — the one place a new flag state is applied (init and every
  // refresh) — to drop the view and keep the raw document. Relies on the SDK's `engine` field,
  // which its types mark protected; if a future SDK moves it, this returns false and nothing
  // here changes behaviour.
  function trackSnapshots(client: FliptClient): boolean {
    const engine = (client as unknown as { engine?: { snapshot?: unknown } }).engine;
    if (!engine || typeof engine.snapshot !== 'function') return false;
    const apply = engine.snapshot as (data: unknown) => unknown;
    const state: { raw: unknown; view: SnapshotView | null } = { raw: undefined, view: null };
    engine.snapshot = function (this: unknown, data: unknown) {
      // Cleared first: if the engine rejects `data` it may or may not have kept its old state,
      // so no raw document is trusted until the next snapshot it accepts.
      state.raw = undefined;
      try {
        const result = apply.call(this, data);
        state.raw = data;
        return result;
      } finally {
        state.view = null;
      }
    };
    tracked.set(client, state);
    return true;
  }

  function snapshotView(client: FliptClient): SnapshotView | null {
    const state = tracked.get(client);
    if (!state) return null;
    if (state.view) return state.view;
    let keys: Set<string> | null = null;
    let constants: Map<string, boolean> | null = null;
    try {
      const listed = client.listFlags();
      keys = new Set(listed.map((f) => f.key));
      constants = buildConstants(listed, state.raw);
    } catch {
      // Unlistable snapshot: no negative cache and no fast path until the next one.
    }
    state.view = { keys, missing: new Map(), constants };
    return state.view;
  }

  // The `noRolloutFastPathSwitch` flag. Evaluated on the engine directly — never through
  // `evalBooleanCached` — so reading it cannot recurse into the fast path it gates.
  function noRolloutSwitchOn(client: FliptClient): boolean {
    if (!noRolloutFastPathSwitch) return false;
    const now = Date.now();
    if (now < noRolloutSwitchExpiresAt) return noRolloutSwitchValue;
    noRolloutSwitchExpiresAt = now + NO_ROLLOUT_SWITCH_REFRESH_MS;
    const override = localOverrides[noRolloutFastPathSwitch];
    if (override !== undefined) {
      noRolloutSwitchValue = override === 'on';
      return noRolloutSwitchValue;
    }
    try {
      noRolloutSwitchValue = client.evaluateBoolean({
        flagKey: noRolloutFastPathSwitch,
        entityId: 'global',
        context: {},
      }).enabled;
    } catch {
      noRolloutSwitchValue = false;
    }
    return noRolloutSwitchValue;
  }

  async function getInstance(): Promise<FliptClient | null> {
    if (instance) return instance;

    // Circuit breaker: skip re-init during cooldown after a failure
    if (Date.now() - lastFailureTime < config.failureCooldownMs) return null;
    if (initializing) return initializing;

    initializing = (async () => {
      try {
        // Resolved here, not at construction: a missing FLIPT_URL must degrade this instance to
        // fail-closed, not throw out of the import that built it.
        const connection =
          config.url && config.clientToken
            ? { url: config.url, clientToken: config.clientToken }
            : loadFliptConnection();

        const initPromise = (async () => {
          const client = await FliptClient.init({
            environment: config.environment,
            url: connection.url,
            authentication: { clientToken: connection.clientToken },
            updateInterval: config.updateIntervalSeconds,
          });
          // `init` applied its snapshot before the hook existed. Forgetting the etag makes the
          // refresh below download the current document again instead of getting a 304, so
          // the hook sees it. If that download fails, the fast path just waits for the next
          // changed snapshot.
          if (trackSnapshots(client)) {
            (client as unknown as { etag?: string }).etag = undefined;
          }
          await client.refresh();
          return client;
        })();

        // Attach a no-op catch to prevent unhandled rejection if timeout wins but initPromise
        // later rejects
        initPromise.catch(() => null);

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Flipt init timeout')), config.initTimeoutMs)
        );

        instance = await Promise.race([initPromise, timeoutPromise]);
        return instance;
      } catch (e) {
        onInitError(e as Error);
        instance = null;
        lastFailureTime = Date.now();
        return null;
      } finally {
        initializing = null;
      }
    })();

    return initializing;
  }

  // Evaluate against the wasm engine, memoized. Throws on engine error so callers keep their
  // fallback; only successful evaluations are cached.
  //
  // Per-request wasm `evaluateBoolean`/`evaluateVariant` calls showed up as a top-10 CPU frame
  // under load (~1500 req/s on a single JS thread). The engine result for a given
  // (flag, entityId, context) is stable between config refreshes, so a short in-process TTL cache
  // collapses the wasm call rate.
  function evalBooleanCached(
    client: FliptClient,
    flag: string,
    entityId: string,
    context: Record<string, string>
  ): boolean {
    if (bypass.has(flag)) {
      return client.evaluateBoolean({ flagKey: flag, entityId, context }).enabled;
    }
    // A blank flag or entity id is rejected by the SDK before the engine sees it, with its own
    // error; leave those to it.
    const snapshot = flag.trim() !== '' && entityId.trim() !== '' ? snapshotView(client) : null;
    if (snapshot) {
      // A key this snapshot does not have: rethrow the engine's error from the first attempt
      // instead of asking again. The next snapshot starts with an empty map.
      if (snapshot.missing.has(flag)) throw snapshot.missing.get(flag);
      const constant = snapshot.constants?.get(flag);
      if (constant !== undefined && noRolloutSwitchOn(client)) return constant;
    }
    const now = Date.now();
    const key = evalCacheKey(flag, entityId, context);
    const cached = boolCache.get(key, now);
    if (cached.hit) return cached.value as boolean;
    let enabled: boolean;
    try {
      enabled = client.evaluateBoolean({ flagKey: flag, entityId, context }).enabled;
    } catch (e) {
      // Remembered only when the engine itself does not list the key, so any other failure
      // keeps being retried as before.
      if (snapshot?.keys && !snapshot.keys.has(flag)) snapshot.missing.set(flag, e);
      throw e;
    }
    boolCache.set(key, enabled, now);
    return enabled;
  }

  function evalVariantCached(
    client: FliptClient,
    flag: string,
    entityId: string,
    context: Record<string, string>
  ): string | null {
    if (bypass.has(flag)) {
      const evaluation = client.evaluateVariant({ flagKey: flag, entityId, context });
      return evaluation.match ? evaluation.variantKey : null;
    }
    const now = Date.now();
    const key = evalCacheKey(flag, entityId, context);
    const cached = variantCache.get(key, now);
    if (cached.hit) return cached.value as string | null;
    const evaluation = client.evaluateVariant({ flagKey: flag, entityId, context });
    const result = evaluation.match ? evaluation.variantKey : null;
    variantCache.set(key, result, now);
    return result;
  }

  return {
    config,

    getClientSync: () => instance,

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
        return evalVariantCached(client, flag, entityId, context);
      } catch (e) {
        onEvalError(e, flag);
        return null;
      }
    },

    isEnabledSync(flag, entityId = 'global', context = {}) {
      if (localOverrides[flag] !== undefined) return localOverrides[flag] === 'on';
      if (!instance) return null;
      try {
        return evalBooleanCached(instance, flag, entityId, context);
      } catch {
        // Swallow eval errors (incl. "flag not found"); caller falls back to null
        return null;
      }
    },
    getCacheStats() {
      return { boolean: boolCache.stats(), variant: variantCache.stats() };
    },
  };
}
