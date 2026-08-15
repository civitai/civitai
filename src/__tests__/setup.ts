import { vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { dbMock } from './mocks/db.mock';
import { redisMock } from './mocks/redis.mock';
import { loggingMock } from './mocks/logging.mock';
import { env, setEnvDefaults } from './mocks/env.mock';
import { resetSharedMocks } from './mocks';

// Canonical shared-module mocks. Registered here, for every test file, rather than per
// file — see docs/testing/shared-module-mocks.md. Under `isolate: false` a source module
// that imports one of these is evaluated ONCE per worker and captures its bindings then,
// so a per-file mock object freezes that file's shape for every later file in the worker.
// One registration with one stable object removes the question.
//
// Runs before the test module is imported, which is what makes it the reset point for
// implementations AND call counts.
resetSharedMocks();

// 🔴 Spread the underlying PACKAGE, never `importOriginal` of the app shim.
//
// `~/server/db/client` and `~/server/redis/client` are shims: they re-export their package
// wholesale AND construct real clients at module scope. `importOriginal` evaluates that
// module, so a global registration using it forces real Prisma/Redis construction into
// EVERY test file — including files whose own mocks make that construction impossible.
// `process-vault-items.test.ts` mocks `@prisma/client` without `PrismaClient`, which used to
// be fine because its own db mock replaced the shim; under an `importOriginal` registration
// it died at module scope with `PrismaClient is not a constructor` and collected ZERO tests
// while the failure count stayed at 0. (Found by arabella on her control run, before
// converting anything — which is exactly why she took a control run.)
//
// The package re-exports are all the spread was ever protecting, and importing the package
// directly gets them without evaluating the shim.
vi.mock('~/server/db/client', async () => ({
  ...(await import('@civitai/db/client')),
  dbRead: dbMock.dbRead,
  dbWrite: dbMock.dbWrite,
}));

// The `sys-read-deadline` spread stays for anything else that module exports; the seam is
// overridden after it, so a test can inject a sysRedis read timeout the way it injects a
// `sysRedis.get`. Its default IS that real implementation, so this adds a lever and changes
// no behaviour — see redis.mock.ts. Without it a converted test keeps the real wall-clock
// race, which the mocked client can never lose, and its timeout leg passes asserting nothing.
vi.mock('~/server/redis/client', async () => ({
  ...(await import('@civitai/redis/client')),
  ...(await import('~/server/redis/sys-read-deadline')),
  redis: redisMock.redis,
  sysRedis: redisMock.sysRedis,
  withSysReadDeadline: redisMock.withSysReadDeadline,
}));

// Mock @civitai/client to avoid ESM resolution issues
vi.mock('@civitai/client', () => ({
  // Enums
  BuzzClientAccount: { System: 'System', User: 'User' },
  TransactionType: { Credit: 'Credit', Debit: 'Debit' },
  Priority: { Normal: 'Normal', High: 'High' },
  NsfwLevel: { None: 'None', Soft: 'Soft', Mature: 'Mature', X: 'X' },
  WorkflowStatus: { Pending: 'Pending', Running: 'Running', Completed: 'Completed' },
  KlingMode: {},
  KlingModel: {},
  MiniMaxVideoGenModel: {},
  HaiperVideoGenModel: {},
  ViduVideoGenStyle: {},
  Veo3Version: {},
  Scheduler: {
    EULER_A: 'EULER_A',
    EULER: 'EULER',
    LMS: 'LMS',
    HEUN: 'HEUN',
    DP_M2: 'DP_M2',
    DP_M2A: 'DP_M2A',
    DP_M2SA: 'DP_M2SA',
    DP_M2M: 'DP_M2M',
    DPMSDE: 'DPMSDE',
    DPM_FAST: 'DPM_FAST',
    DPM_ADAPTIVE: 'DPM_ADAPTIVE',
    LMS_KARRAS: 'LMS_KARRAS',
    DP_M2_KARRAS: 'DP_M2_KARRAS',
    DP_M2A_KARRAS: 'DP_M2A_KARRAS',
    DP_M2SA_KARRAS: 'DP_M2SA_KARRAS',
    DP_M2M_KARRAS: 'DP_M2M_KARRAS',
    DPMSDE_KARRAS: 'DPMSDE_KARRAS',
    DP_M3MSDE: 'DP_M3MSDE',
    DDIM: 'DDIM',
    PLMS: 'PLMS',
    UNI_PC: 'UNI_PC',
    LCM: 'LCM',
    UNDEFINED: 'UNDEFINED',
  },
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
  // Functions
  createCivitaiClient: vi.fn(),
  getWorkflow: vi.fn(),
  submitWorkflow: vi.fn(),
  getResource: vi.fn(),
  invalidateResource: vi.fn(),
  handleError: vi.fn(),
  invokeImageUploadStepTemplate: vi.fn(),
  // Misc
  Air: class Air {
    static parse = vi.fn(() => ({ id: '0', version: '0', type: 'model', source: 'civitai' }));
    static stringify = vi.fn(() => '');
  },
}));

// App Blocks: provision a real RSA keypair so BlockTokenService can sign and
// tests can verify against the matching public key. Generated once per test
// process. The public PEM is re-exported so the block-token round-trip test
// verifies against the exact key the service signed with. (The block-tokens
// API "503 when keys not configured" test overrides ~/env/server per-test, so
// these defaults don't interfere with that negative case.)
const { publicKey: _btPublicKey, privateKey: _btPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
export const TEST_BLOCK_TOKEN_PUBLIC_PEM = _btPublicKey.export({
  type: 'spki',
  format: 'pem',
}) as string;
const TEST_BLOCK_TOKEN_PRIVATE_PEM = _btPrivateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;

// The block-token keypair is generated here, per worker, so it has to be pushed into the
// canonical env defaults rather than declared beside them. Worker-level, not per-file:
// BlockTokenService reads it when its module is evaluated.
setEnvDefaults({
  BLOCK_TOKEN_PRIVATE_KEY: TEST_BLOCK_TOKEN_PRIVATE_PEM,
  BLOCK_TOKEN_PUBLIC_KEY: TEST_BLOCK_TOKEN_PUBLIC_PEM,
});

// The @civitai/redis package validates its own env from `process.env` directly (its own schema),
// NOT `~/env/server`, so the mock below doesn't reach it. Set the two required vars (the rest have
// defaults) so loadRedisEnv() succeeds when a test imports the redis shim/package — the `redis`
// driver itself is still mocked per-test, so no real connection is opened.
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.REDIS_SYS_URL ??= 'redis://localhost:6379';

// The @civitai/db package (packages/civitai-db/src/env.ts) has the SAME pattern: it owns its env
// schema and validates `process.env` directly via loadDbEnv(), NOT `~/env/server`, so the Proxy mock
// below doesn't reach it. Any test whose module graph transitively imports a db factory (e.g.
// db-lag-helpers → notifDb → getClient → loadDbEnv) throws "[@civitai/db] Invalid environment
// variables" the moment that import is evaluated — and because that import can race the heavy
// event-engine graph across the worker pool, the failure was INTERMITTENT (green on lighter-loaded
// runs, red under CPU pressure / certain run-order). It also surfaced indirectly as the
// "No 'dbRead' export is defined on the mock" error in fail-soft code paths. Seed the four required
// URLs (the rest have schema defaults) so loadDbEnv() always succeeds in tests; the Prisma clients
// themselves are still mocked per-test (or never connected), so no real DB connection is opened.
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
process.env.DATABASE_REPLICA_URL ??= 'postgres://user:pass@localhost:5432/db';
process.env.NOTIFICATION_DB_URL ??= 'postgres://user:pass@localhost:5432/notif';
process.env.NOTIFICATION_DB_REPLICA_URL ??= 'postgres://user:pass@localhost:5432/notif';

// One `env` object for the worker, reads layered defaults-then-per-file-overrides. A test
// declares what it needs with `setEnv({ … })` instead of replacing the whole module — which
// is what made 109 files each re-enumerate the defaults and drop the ones they forgot.
vi.mock('~/env/server', () => ({ env }));

// Prevent prom/client from initializing real DB pools at module load.
// A metric-shaped stub covering every prom-client surface our code touches
// (Counter.inc, Gauge.inc/dec/set, Histogram.observe, and the .labels()/.startTimer()
// helpers) so any registered metric — named export OR built via a register* factory
// — is safe to call without a real prom-client registry.
const promMetricStub = () => {
  const child = { inc: vi.fn(), dec: vi.fn(), set: vi.fn(), observe: vi.fn() };
  return {
    inc: vi.fn(),
    dec: vi.fn(),
    set: vi.fn(),
    observe: vi.fn(),
    startTimer: vi.fn(() => vi.fn()),
    labels: vi.fn(() => child),
  };
};

vi.mock('~/server/prom/client', () => ({
  // The real value. Modules that build their own prom-client metrics name them
  // `PROM_PREFIX + '...'`, and a stubbed prefix would make every such test assert
  // against a metric name production never emits.
  PROM_PREFIX: 'civitai_app_',
  // Factory functions — modules call these at import time to build their metrics
  // (e.g. meilisearch/client.ts, eventloop-longtask.ts). Each returns a stub.
  registerCounter: vi.fn(promMetricStub),
  registerCounterWithLabels: vi.fn(promMetricStub),
  registerGaugeWithLabels: vi.fn(promMetricStub),
  registerHistogram: vi.fn(promMetricStub),
  registerInstrumentationMetric: vi.fn(promMetricStub),
  // Named metric exports the real module ships.
  placementExhaustedLegsGauge: promMetricStub(),
  placementUnfundedSettlementsGauge: promMetricStub(),
  missingSignedAtCounter: promMetricStub(),
  newUserCounter: promMetricStub(),
  loginCounter: promMetricStub(),
  onboardingCompletedCounter: promMetricStub(),
  onboardingErrorCounter: promMetricStub(),
  leakingContentCounter: promMetricStub(),
  vaultItemProcessedCounter: promMetricStub(),
  vaultItemFailedCounter: promMetricStub(),
  rewardGivenCounter: promMetricStub(),
  rewardFailedCounter: promMetricStub(),
  clavataCounter: promMetricStub(),
  cacheHitCounter: promMetricStub(),
  cacheMissCounter: promMetricStub(),
  cacheRevalidateCounter: promMetricStub(),
  trpcProcedureDuration: promMetricStub(),
  imagesFeedWithoutIndexCounter: promMetricStub(),
  creatorCompCreatorsPaidCounter: promMetricStub(),
  creatorCompAmountPaidCounter: promMetricStub(),
  licenseFeeCreatorsPaidCounter: promMetricStub(),
  licenseFeeAmountPaidCounter: promMetricStub(),
  userUpdateCounter: promMetricStub(),
  dbReadFallbackCounter: promMetricStub(),
  // App-Blocks W4 KV storage metrics (apps.router). promMetricStub() covers the
  // .inc()/.labels()/.observe()/.startTimer() surface these tests exercise.
  appStorageOpsCounter: promMetricStub(),
  appStorageQuotaExceededCounter: promMetricStub(),
  appStorageLatencyHistogram: promMetricStub(),
  // sysRedis sentinel observability counters (PR #2331 round-3).
  sysredisSentinelTopologyChangesCounter: promMetricStub(),
  sysredisSentinelClientErrorsCounter: promMetricStub(),
  // Cron runner + image-ingestion cron metrics (job.ts / image-ingestion.ts).
  jobDurationHistogram: promMetricStub(),
  jobErrorsCounter: promMetricStub(),
  imageIngestCronCounter: promMetricStub(),
  imageIngestCronQueueDepth: promMetricStub(),
  imageScanWebhookCounter: promMetricStub(),
}));

// Mock logging.
//
// 🔴 Spreads the ORIGINAL rather than replacing the module with a one-key object.
// `~/server/logging/client` has 7 exports; the previous wholesale mock provided
// exactly one, so ANY code path reaching a second one died with
// `[vitest] No "<name>" export is defined on the mock` — an error that surfaces
// far from its cause. It bit when the REST routes were consolidated onto
// `handleEndpointError` (civitai#3845/4): the helper needs `buildCentralErrorLog`
// and `wasServerFaultLogged`, so nine previously-green route tests broke for a
// reason that had nothing to do with what they assert. Only `logToAxiom` is
// stubbed, because that is the one with an I/O side effect a test must not do.
// The spy comes from the canonical mock rather than being built inline: under
// `isolate: false` this factory runs once per WORKER, so an inline `vi.fn()` pooled its
// call counts across every file sharing that worker.
vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logToAxiom: loggingMock.logToAxiom,
}));

// Mock session invalidation
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}));

// Mock Freshdesk integration
vi.mock('~/server/integrations/freshdesk', () => ({
  upsertContact: vi.fn().mockResolvedValue(undefined),
}));

// Mock subscription cache invalidation
vi.mock('~/server/utils/subscription.utils', () => ({
  invalidateSubscriptionCaches: vi.fn().mockResolvedValue(undefined),
}));
