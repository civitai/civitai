import { vi } from 'vitest';

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

// Mock environment variables. Use a Proxy so any env.X access returns a
// reasonable default — saves us from enumerating every URL/endpoint var that
// production code happens to read at module load.
const TEST_ENV_DEFAULTS: Record<string, unknown> = {
  TIER_METADATA_KEY: 'tier',
  BUZZ_ENDPOINT: 'http://mock-buzz-endpoint',
  LOGGING: '',
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
  NEXTAUTH_URL: 'http://localhost:3000',
  NEXTAUTH_SECRET: 'test-secret',
  S3_UPLOAD_ENDPOINT: 'http://localhost:9000',
  S3_IMAGE_UPLOAD_ENDPOINT: 'http://localhost:9000',
  ORCHESTRATOR_ENDPOINT: 'http://localhost:8080',
  SIGNALS_ENDPOINT: 'http://localhost:8081',
  FLIPT_URL: 'http://localhost:8082',
  EMAIL_HOST: 'smtp.localhost',
  S3_UPLOAD_KEY: 'test-key',
  S3_UPLOAD_SECRET: 'test-secret',
  S3_IMAGE_UPLOAD_KEY: 'test-key',
  S3_IMAGE_UPLOAD_SECRET: 'test-secret',
};

vi.mock('~/env/server', () => ({
  env: new Proxy(TEST_ENV_DEFAULTS, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      // Anything else: return undefined (matches missing optional env vars).
      return undefined;
    },
  }),
}));

// Prevent prom/client from initializing real DB pools at module load.
vi.mock('~/server/prom/client', () => ({
  registerCounter: vi.fn(() => ({ inc: vi.fn() })),
  registerCounterWithLabels: vi.fn(() => ({ inc: vi.fn(), labels: vi.fn(() => ({ inc: vi.fn() })) })),
  missingSignedAtCounter: { inc: vi.fn() },
  newUserCounter: { inc: vi.fn() },
  loginCounter: { inc: vi.fn() },
  onboardingCompletedCounter: { inc: vi.fn() },
  onboardingErrorCounter: { inc: vi.fn() },
  leakingContentCounter: { inc: vi.fn() },
  vaultItemProcessedCounter: { inc: vi.fn() },
  vaultItemFailedCounter: { inc: vi.fn() },
  rewardGivenCounter: { inc: vi.fn() },
  rewardFailedCounter: { inc: vi.fn() },
  clavataCounter: { inc: vi.fn() },
  cacheHitCounter: { inc: vi.fn(), labels: vi.fn(() => ({ inc: vi.fn() })) },
  cacheMissCounter: { inc: vi.fn(), labels: vi.fn(() => ({ inc: vi.fn() })) },
  cacheRevalidateCounter: { inc: vi.fn(), labels: vi.fn(() => ({ inc: vi.fn() })) },
  imagesFeedWithoutIndexCounter: { inc: vi.fn() },
  creatorCompCreatorsPaidCounter: { inc: vi.fn(), labels: vi.fn(() => ({ inc: vi.fn() })) },
  creatorCompAmountPaidCounter: { inc: vi.fn(), labels: vi.fn(() => ({ inc: vi.fn() })) },
  userUpdateCounter: { inc: vi.fn(), labels: vi.fn(() => ({ inc: vi.fn() })) },
  dbReadFallbackCounter: { inc: vi.fn(), labels: vi.fn(() => ({ inc: vi.fn() })) },
}));

// Mock logging
vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
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
