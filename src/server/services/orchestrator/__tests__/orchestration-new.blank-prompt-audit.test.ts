import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `generateFromGraph` must hand an empty prompt + non-empty negative prompt to the audit.
 *
 * Image-input families (img2img and similar) make the prompt optional when images are supplied, so
 * a submission can carry an empty prompt beside a negative prompt. The call site used to gate the
 * audit on the prompt alone, which skipped the negative prompt entirely. It now uses
 * `isBlankAuditInput`, the same both-fields-empty rule the audit itself applies.
 *
 * `auditPromptServer` is a spy here: what it decides is covered by
 * `promptAuditing.blank-prompt.test.ts`; this file pins only that the call site reaches it. The
 * non-empty-prompt case is the positive control proving the fixture validates and reaches the audit
 * at all, so the "not called" case cannot pass because the submission died earlier.
 *
 * The mock preamble mirrors `orchestration-new.raw-air.test.ts`: it keeps the heavy DB module graph
 * inert so the module imports. Submissions die later in step assembly — irrelevant here.
 */

const { mockAuditPromptServer, mockXGuard } = vi.hoisted(() => ({
  mockAuditPromptServer: vi.fn(async (): Promise<void> => undefined),
  mockXGuard: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/orchestrator/promptAuditing', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptAuditingMod>()),
  auditPromptServer: mockAuditPromptServer,
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorServiceMod>()),
  createXGuardModerationRequest: mockXGuard,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: {}, datapacketDbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveTestingAccess: vi.fn(async () => false),
  getGateRules: vi.fn(async () => []),
  getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
  getResourceData: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));

import type * as PromptAuditingMod from '~/server/services/orchestrator/promptAuditing';
import type * as OrchestratorServiceMod from '~/server/services/orchestrator/orchestrator.service';
import type { GenerationCtx } from '~/shared/generation/context';
import { generateFromGraph } from '~/server/services/orchestrator/orchestration-new.service';

const USER_ID = 5;
const IMG = { url: 'https://image.civitai.com/a.png', width: 1024, height: 1024 };

const externalCtx = (): GenerationCtx => ({
  limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
  user: { isMember: true, tier: 'bronze' },
  flags: {},
  selfHostedDisabledEcosystems: [],
  selfHostedMode: 'enabled',
  gateRules: [],
});

const img2img = (prompt: string, negativePrompt: string) => ({
  workflow: 'img2img',
  ecosystem: 'SDXL',
  model: { id: 128078 },
  images: [IMG],
  prompt,
  negativePrompt,
  sampler: 'Euler',
  steps: 25,
  quantity: 1,
  priority: 'low',
});

const submit = (prompt: string, negativePrompt: string) =>
  generateFromGraph({
    input: img2img(prompt, negativePrompt),
    externalCtx: externalCtx(),
    token: 'token',
    userId: USER_ID,
    isModerator: false,
  } as never).catch(() => undefined);

beforeEach(() => {
  mockAuditPromptServer.mockReset();
  mockAuditPromptServer.mockImplementation(async () => undefined);
  mockXGuard.mockClear();
});

describe('generateFromGraph — the prompt audit gate', () => {
  it('positive control: a non-empty prompt reaches the audit', async () => {
    await submit('a cat', 'blurry');
    expect(mockAuditPromptServer).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a cat', negativePrompt: 'blurry', userId: USER_ID })
    );
  });

  it('a non-empty prompt with an empty negative prompt reaches the audit', async () => {
    await submit('a cat', '');
    expect(mockAuditPromptServer).toHaveBeenCalledTimes(1);
    expect(mockAuditPromptServer).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a cat', negativePrompt: '' })
    );
  });

  it('an empty prompt beside a non-empty negative prompt reaches the audit', async () => {
    await submit('', 'blurry');
    expect(mockAuditPromptServer).toHaveBeenCalledTimes(1);
    expect(mockAuditPromptServer).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '', negativePrompt: 'blurry', userId: USER_ID })
    );
  });

  it('a blocked empty-prompt submission hands the shadow scan an empty string, not undefined', async () => {
    mockAuditPromptServer.mockImplementationOnce(async () => {
      throw new Error('Your prompt was flagged');
    });
    await submit('', 'blurry');
    expect(mockXGuard).toHaveBeenCalledTimes(1);
    expect(mockXGuard).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'prompt', positivePrompt: '', negativePrompt: 'blurry' })
    );
  });

  // Invariant guard: held before the change too.
  it('both fields empty does not call the audit', async () => {
    await submit('', '');
    expect(mockAuditPromptServer).not.toHaveBeenCalled();
  });
});
