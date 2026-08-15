/**
 * Canonical mock for `~/env/server`.
 *
 * The other canonical mocks vivify a call surface; this one is a value table, so the shape
 * is different: one stable `env` object whose READS are answered from a worker-level default
 * map layered under a per-file override map, with the override map cleared between files.
 *
 * The stable identity is the point, same as elsewhere. A module that does
 * `const host = new URL(env.S3_UPLOAD_ENDPOINT)` at module scope captures `env` once per
 * worker under `isolate: false`, so handing out a fresh object per file cannot work.
 *
 * 🔴 KNOWN LIMIT, and it is inherent rather than a shortcoming of this design.
 * A per-file override cannot affect a read that already happened at MODULE SCOPE in the code
 * under test: with `isolate: false` that module is evaluated once per worker, and whichever
 * file triggered that evaluation is the only one whose overrides were visible. This is not a
 * regression — a per-file `vi.mock('~/env/server')` factory has exactly the same problem,
 * because it too runs once per worker. Where a test needs a module-load-time value, the value
 * belongs in TEST_ENV_DEFAULTS (worker-level, set before anything imports), not in a per-file
 * override.
 */
const defaults: Record<string, unknown> = {};
const overrides = new Map<string, unknown>();

/** Worker-level, applied before any test file runs. For values a module reads at import. */
export function setEnvDefaults(values: Record<string, unknown>) {
  Object.assign(defaults, values);
}

/** Per-file, cleared by the global setup between files. For values read at call time. */
export function setEnv(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) overrides.set(key, value);
}

export function resetEnv() {
  overrides.clear();
}

/** A getter installed by `Object.defineProperty(env, …)`; re-read on every access so a test
 * that defines a live accessor keeps getting live values. */
type Accessor = { __envAccessor: () => unknown };
const isAccessor = (v: unknown): v is Accessor =>
  typeof v === 'object' && v !== null && '__envAccessor' in v;

function read(prop: string) {
  const value = overrides.has(prop) ? overrides.get(prop) : defaults[prop];
  // Absent means absent: an unset optional env var reads as undefined in production too.
  return isAccessor(value) ? value.__envAccessor() : value;
}

export const env: Record<string, unknown> = new Proxy(
  {},
  {
    get(_target, prop: string | symbol) {
      return typeof prop === 'string' ? read(prop) : undefined;
    },
    has() {
      return true;
    },
    ownKeys() {
      return [...new Set([...Object.keys(defaults), ...overrides.keys()])];
    },
    // 🔴 The descriptor must carry a `value` and must stay `configurable`. Several tests
    // reach for `Object.defineProperty(env, 'FLAG', …)` to flip one variable, and a proxy
    // that reports a descriptor inconsistent with what `defineProperty` then writes trips
    // the invariant check with `TypeError: Cannot redefine property` on the SECOND call —
    // which surfaces as a dozen unrelated failures in one file.
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return { value: read(prop), writable: true, enumerable: true, configurable: true };
    },
    defineProperty(_target, prop, descriptor) {
      if (typeof prop === 'string')
        overrides.set(
          prop,
          descriptor.get ? ({ __envAccessor: descriptor.get } as Accessor) : descriptor.value
        );
      return true;
    },
    set(_target, prop, value) {
      if (typeof prop === 'string') overrides.set(prop, value);
      return true;
    },
    deleteProperty(_target, prop) {
      if (typeof prop === 'string') overrides.set(prop, undefined);
      return true;
    },
  }
);

export const envMock = { set: setEnv, setDefaults: setEnvDefaults, reset: resetEnv };

/**
 * The defaults every test starts from. A Proxy rather than an enumerated object was the
 * original point: production code reads a long tail of URL/endpoint vars at module load, and
 * enumerating all of them is how the previous per-file mocks became partial.
 */
export const TEST_ENV_DEFAULTS: Record<string, unknown> = {
  TIER_METADATA_KEY: 'tier',
  BUZZ_ENDPOINT: 'http://mock-buzz-endpoint',
  // meilisearch/client.ts feeds this straight into pLimit() at module load — an undefined
  // value makes p-limit throw "Expected concurrency to be a number". Mirrors the production
  // default (server-schema.ts: .default(50)).
  MEILI_CALL_CONCURRENCY: 50,
  MEILI_RESOURCE_SELECT_CONCURRENCY: 500,
  SIGNALS_CALL_CONCURRENCY: 30,
  // `commaDelimitedStringArray()` in server-schema, so production hands consumers a string[]
  // and `~/utils/logging` does `env.LOGGING.includes(name)`. A `''` default answered that
  // call correctly by accident — String.prototype.includes — which is why the wrong type
  // never threw, and why ten test files had each set `[]` by hand to get the real shape.
  LOGGING: [] as string[],
  FORGEJO_PUBLIC_URL: 'https://forgejo.civitai.com',
  APPS_DOMAIN: 'civit.ai',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  NOTIFICATION_DB_URL: 'postgres://user:pass@localhost:5432/notif',
  DATABASE_SSL: false,
  DATABASE_POOL_MAX: 10,
  DATABASE_POOL_IDLE_TIMEOUT: 30000,
  DATABASE_CONNECTION_TIMEOUT: 5000,
  DATABASE_WRITE_TIMEOUT: 10000,
  DATABASE_READ_TIMEOUT: 10000,
  REDIS_URL: 'redis://localhost:6379',
  REDIS_SYS_URL: 'redis://localhost:6379',
  REDIS_SYS_SOCKET_TIMEOUT_MS: 0,
  REDIS_SYS_READ_TIMEOUT_MS: 2000,
  REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH: 10000,
  NEXTAUTH_URL: 'http://localhost:3000',
  NEXTAUTH_SECRET: 'test-secret',
  // endpoint-helpers spreads TRPC_ORIGINS at module load, so an undefined value makes
  // importing ANY api page throw "is not iterable". Non-empty tokens below so a request that
  // omits `?token=` genuinely fails the check rather than matching `undefined !== undefined`.
  TRPC_ORIGINS: [] as string[],
  WEBHOOK_TOKEN: 'test-webhook-token',
  JOB_TOKEN: 'test-job-token',
  S3_UPLOAD_ENDPOINT: 'http://localhost:9000',
  S3_IMAGE_UPLOAD_ENDPOINT: 'http://localhost:9000',
  ORCHESTRATOR_ENDPOINT: 'http://localhost:8080',
  SIGNALS_ENDPOINT: 'http://localhost:8081',
  // Read by clickhouse/client.ts at MODULE scope, so it has to be a worker-level default: a
  // per-file override arrives after that module was already evaluated for the worker. This
  // is the class that distinguishes env from the call-surface mocks — see the KNOWN LIMIT
  // note at the top.
  CLICKHOUSE_TRACKER_URL: 'http://tracker.test',
  FLIPT_URL: 'http://localhost:8082',
  EMAIL_HOST: 'smtp.localhost',
  S3_UPLOAD_KEY: 'test-key',
  S3_UPLOAD_SECRET: 'test-secret',
  S3_IMAGE_UPLOAD_KEY: 'test-key',
  S3_IMAGE_UPLOAD_SECRET: 'test-secret',
};

setEnvDefaults(TEST_ENV_DEFAULTS);
