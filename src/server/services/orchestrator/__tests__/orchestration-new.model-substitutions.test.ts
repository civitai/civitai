import { describe, expect, it, vi } from 'vitest';

/**
 * `formatGenerationResponse2` must SURFACE persisted silent-checkpoint
 * substitutions (#3520 / #3665).
 *
 * 🔴 WHY THIS TEST EXISTS AT ALL. `normalizedWfMeta` is built from an explicit
 * key ALLOWLIST (`params`, `resources`, `remixOfId`, `isPrivateGeneration`),
 * not a spread. So persisting `modelSubstitutions` on the orchestrator
 * workflow's metadata — which is what the App Blocks path does, and what the
 * obvious reading of #3665 says to copy — is NOT sufficient on the generation
 * path: the key round-trips through the orchestrator perfectly and this
 * formatter drops it again on read-back. The record would exist, be billed
 * against, and reach nobody.
 *
 * The App Blocks author knew this and said so — the old comment on
 * `WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY` noted the formatter "builds its
 * normalized metadata from a fixed key list, so an extra key is inert there."
 * It was inert. That is precisely the defect, and this pins the fix.
 *
 * The fixture carries NO resources, so `getResourceData` is never reached and
 * this drives the real formatter rather than a mock of it. The mock preamble
 * mirrors `orchestration-new.air-map.test.ts` — it only keeps the heavy
 * DB/redis module graph inert so the module imports.
 */

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p: Promise<unknown>) => p),
  };
});
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

import { formatGenerationResponse2 } from '~/server/services/orchestrator/orchestration-new.service';
import { WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY } from '~/shared/data-graph/generation/model-substitution';
import { dbMock } from '~/__tests__/mocks/db.mock';

const SUBSTITUTION = { requested: 999999999, applied: 2436219, reason: 'unrecognized' as const };

/**
 * A workflow with workflow-level metadata (`params` present — that is what makes
 * the formatter take the `hasWfMeta` branch) and no resources of any kind.
 */
function workflowWithMetadata(extra: Record<string, unknown>) {
  return {
    id: 'wf-1',
    status: 'succeeded',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    steps: [],
    metadata: { params: { prompt: 'a cat' }, ...extra },
  } as never;
}

async function formatOne(extra: Record<string, unknown>) {
  const [formatted] = await formatGenerationResponse2([workflowWithMetadata(extra)]);
  return formatted;
}

describe('formatGenerationResponse2 — persisted modelSubstitutions', () => {
  it('🔴 surfaces the record persisted on the workflow metadata', async () => {
    const formatted = await formatOne({
      [WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY]: [SUBSTITUTION],
    });
    expect(formatted.metadata?.modelSubstitutions).toEqual([SUBSTITUTION]);
  });

  it('POSITIVE CONTROL: the fixture really does reach the metadata branch', async () => {
    // Without this, an assertion that the key is ABSENT below could pass because
    // the formatter produced no metadata at all — a green that says nothing.
    const formatted = await formatOne({});
    expect(formatted.metadata).toBeDefined();
    expect(formatted.metadata?.params).toMatchObject({ prompt: 'a cat' });
  });

  it('omits the key entirely when nothing was substituted', async () => {
    const formatted = await formatOne({});
    expect(formatted.metadata && 'modelSubstitutions' in formatted.metadata).toBe(false);
  });

  it('omits the key when the persisted value is an empty array', async () => {
    const formatted = await formatOne({ [WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY]: [] });
    expect(formatted.metadata && 'modelSubstitutions' in formatted.metadata).toBe(false);
  });

  it('🔴 DROPS malformed entries rather than putting them on the wire', async () => {
    // This crosses a service boundary — the value is whatever the orchestrator
    // hands back — and `reason` is simultaneously a wire contract and a BOUNDED
    // prom label, so an unrecognised value must not survive the read.
    const formatted = await formatOne({
      [WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY]: [
        SUBSTITUTION,
        { requested: 1, applied: 2, reason: 'not-a-real-reason' },
        { requested: 'x', applied: 2, reason: 'unrecognized' },
        { requested: 1, applied: Number.NaN, reason: 'unrecognized' },
        null,
        'nonsense',
      ],
    });
    expect(formatted.metadata?.modelSubstitutions).toEqual([SUBSTITUTION]);
  });

  it('ignores a non-array value', async () => {
    const formatted = await formatOne({
      [WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY]: { requested: 1 },
    });
    expect(formatted.metadata && 'modelSubstitutions' in formatted.metadata).toBe(false);
  });
});
