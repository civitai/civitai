import { serverSchema } from '~/env/server-schema';

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

/**
 * Extract every schema field's default value by parsing `undefined` through each field.
 * Fields without a .default() (required fields, optional-without-default) throw on
 * `parse(undefined)` and are skipped — those need explicit test values below.
 *
 * This is the single source of truth: a key gaining a `.default()` in the schema
 * automatically appears here, so the hand-enumerated list can never silently diverge.
 */
function schemaDefaults(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(serverSchema.shape)) {
    try {
      const parsed = field.parse(undefined);
      if (parsed !== undefined) result[key] = parsed;
    } catch {
      // Required fields or optional fields without .default() — need explicit test values
    }
  }
  return result;
}

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
 * The defaults every test starts from. Derived from the env schema's own .default()
 * values, with test-specific overrides layered on top for values the schema leaves
 * required (no default) or where the test needs a different value.
 *
 * 🔴 The schema-derived base means a key gaining a `.default()` in the schema
 * automatically appears here — the hand-enumerated divergence that caused OC-317
 * (REPLICATION_LAG_DELAY missing, read as undefined under test) cannot recur.
 */
export const TEST_ENV_DEFAULTS: Record<string, unknown> = {
  // Schema-derived defaults (every .default() from serverSchema)
  ...schemaDefaults(),

  // ── Test-specific overrides ──────────────────────────────────────────────
  // Required fields the schema leaves without defaults — tests need values:
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  NOTIFICATION_DB_URL: 'postgres://user:pass@localhost:5432/notif',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_SYS_URL: 'redis://localhost:6379',
  NEXTAUTH_URL: 'http://localhost:3000',
  NEXTAUTH_SECRET: 'test-secret',
  WEBHOOK_TOKEN: 'test-webhook-token',
  JOB_TOKEN: 'test-job-token',
  S3_UPLOAD_ENDPOINT: 'http://localhost:9000',
  S3_IMAGE_UPLOAD_ENDPOINT: 'http://localhost:9000',
  ORCHESTRATOR_ENDPOINT: 'http://localhost:8080',
  ORCHESTRATOR_ACCESS_TOKEN: 'test-orchestrator-token',
  SIGNALS_ENDPOINT: 'http://localhost:8081',
  CLICKHOUSE_TRACKER_URL: 'http://tracker.test',
  FLIPT_URL: 'http://localhost:8082',
  EMAIL_HOST: 'smtp.localhost',
  S3_UPLOAD_KEY: 'test-key',
  S3_UPLOAD_SECRET: 'test-secret',
  S3_IMAGE_UPLOAD_KEY: 'test-key',
  S3_IMAGE_UPLOAD_SECRET: 'test-secret',
  BUZZ_ENDPOINT: 'http://mock-buzz-endpoint',
  LOGGING: '',

  // Schema defaults overridden for test speed/behaviour:
  DATABASE_SSL: false, // schema default: true — tests don't need SSL
  DATABASE_POOL_MAX: 10, // schema default: 20 — smaller pool for tests
  DATABASE_CONNECTION_TIMEOUT: 5000, // schema default: 0 — give tests a real timeout
  DATABASE_WRITE_TIMEOUT: 10000, // schema has no default (optional) — tests need a value
  DATABASE_READ_TIMEOUT: 10000, // schema has no default (optional) — tests need a value
};

setEnvDefaults(TEST_ENV_DEFAULTS);
