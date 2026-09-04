import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as ShadowParse from '~/server/services/orchestrator/form-graph/shadow-parse';

/**
 * The cutover's flip criterion depends on `validateInput` actually invoking the
 * shadow comparison once per parse — the shadow-parse suite tests the functions,
 * not this caller. Mock preamble mirrors `orchestration-new.collector-attach.test.ts`:
 * it only keeps the heavy DB/redis module graph inert so the module imports.
 */

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

const shadow = vi.hoisted(() => ({
  flags: { serve: false, shadow: false },
  record: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/form-graph/shadow-parse', async (importOriginal) => {
  const mod = await importOriginal<typeof ShadowParse>();
  return {
    ...mod,
    shadowFlags: vi.fn(() => shadow.flags),
    recordShadowComparison: shadow.record,
  };
});

import { createWorkflowStepsFromGraphInput } from '~/server/services/orchestrator/orchestration-new.service';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { dbMock } from '~/__tests__/mocks/db.mock';

void dbMock;

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const INPUT = { workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat' };

// Step-building may fail on the inert mocks downstream of validateInput; the
// tap fires (or not) before that, which is all this suite asserts.
const run = () =>
  createWorkflowStepsFromGraphInput({ input: { ...INPUT }, externalCtx: EXT }).catch(
    () => undefined
  );

describe('validateInput shadow tap', () => {
  beforeEach(() => shadow.record.mockClear());

  it('with the shadow flag on, one parse records exactly one comparison', async () => {
    shadow.flags = { serve: false, shadow: true };
    await run();
    expect(shadow.record).toHaveBeenCalledTimes(1);
    const [v1, hub, workflow] = shadow.record.mock.calls[0];
    expect(v1).toHaveProperty('success');
    expect(hub).toHaveProperty('ok');
    expect(workflow).toBe('txt2img');
  });

  it('with both flags off, the hub parse never runs', async () => {
    shadow.flags = { serve: false, shadow: false };
    await run();
    expect(shadow.record).not.toHaveBeenCalled();
  });
});
