import { FliptClient } from '@flipt-io/flipt-client-js';
import { fliptCacheKey, TtlCache } from './cache';
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
};

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
    const now = Date.now();
    const key = fliptCacheKey(flag, entityId, context);
    const cached = boolCache.get(key, now);
    if (cached.hit) return cached.value as boolean;
    const { enabled } = client.evaluateBoolean({ flagKey: flag, entityId, context });
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
    const key = fliptCacheKey(flag, entityId, context);
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
  };
}
