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
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
  // Functions
  createCivitaiClient: vi.fn(),
  getWorkflow: vi.fn(),
  submitWorkflow: vi.fn(),
  getResource: vi.fn(),
  invalidateResource: vi.fn(),
  handleError: vi.fn(),
  invokeImageUploadStepTemplate: vi.fn(),
}));

// Mock environment variables
vi.mock('~/env/server', () => ({
  env: {
    TIER_METADATA_KEY: 'tier',
    BUZZ_ENDPOINT: 'http://mock-buzz-endpoint',
  },
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
  updateServiceTier: vi.fn().mockResolvedValue(undefined),
}));

// Mock subscription cache invalidation
vi.mock('~/server/utils/subscription.utils', () => ({
  invalidateSubscriptionCaches: vi.fn().mockResolvedValue(undefined),
}));
