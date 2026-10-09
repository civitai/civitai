import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

/**
 * Regression guard for the GenerationDisabled flag gate.
 *
 * The generation blacklist lives on `ModelVersion.flags` (bit 1 / value 2). This
 * matrix pins the ONE thing that must never silently regress: a version carrying
 * that bit is not generatable, and a version carrying a DIFFERENT flag still is
 * (guards against bit confusion when a new flag is added to the shared column).
 */

// Collapse the heavy sibling-service graph — `getResourceCanGenerate` is pure,
// but importing generation.service pulls in DB / search-index / image infra.
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn(), mGet: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p: Promise<unknown>) => p),
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: {} }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: vi.fn() }));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({
  getLinkedVaeIds: vi.fn(),
  bustMvCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({ imagesForModelVersionsCache: {} }));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

import {
  getResourceCanGenerate,
  getShouldChargeForResources,
  isAdditionalResourceFeeExempt,
  setAdditionalResourceFeeWaived,
  setEvictable,
  toggleGenerationDisabled,
} from '~/server/services/generation/generation.service';
import { bustMvCache } from '~/server/services/model-version.service';
import { getFeaturedModels } from '~/server/services/model.service';
import { ModelVersionFlag } from '~/shared/constants/model-version-flags.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';

const noHiddenGates = { ecosystems: new Set<string>(), versionIds: new Set<number>() };

// A published, covered, public version owned by someone else — generatable in
// every respect EXCEPT whatever `flags` says.
const baseResource = {
  id: 1,
  status: 'Published',
  availability: 'Public',
  baseModel: 'SD 1.5',
  covered: true,
  modelUserId: 999,
};

const canGenerate = (flags: number) =>
  getResourceCanGenerate({
    resource: { ...baseResource, flags },
    user: { id: 123, isModerator: false },
    hiddenGates: noHiddenGates,
  });

describe('getResourceCanGenerate — GenerationDisabled flag', () => {
  it('allows generation when no flags are set', () => {
    expect(canGenerate(ModelVersionFlag.None)).toBe(true);
  });

  it('BLOCKS generation when GenerationDisabled is set', () => {
    expect(canGenerate(ModelVersionFlag.GenerationDisabled)).toBe(false);
  });

  it('blocks when GenerationDisabled is combined with another flag', () => {
    expect(canGenerate(ModelVersionFlag.GenerationDisabled | ModelVersionFlag.NotDerivative)).toBe(
      false
    );
  });

  it('does NOT block on an unrelated flag (bit-confusion guard)', () => {
    expect(canGenerate(ModelVersionFlag.NotDerivative)).toBe(true);
    // Retired bit 0 (was DisablePayout) — rows in the wild still carry it.
    expect(canGenerate(1)).toBe(true);
  });

  it('blocks a moderator too — the flag is not a visibility gate', () => {
    const result = getResourceCanGenerate({
      resource: { ...baseResource, flags: ModelVersionFlag.GenerationDisabled },
      user: { id: 123, isModerator: true },
      hiddenGates: noHiddenGates,
    });
    expect(result).toBe(false);
  });
});

describe('getShouldChargeForResources — NoAdditionalResourceFee flag', () => {
  const MODEL_ID = 42;
  // A 200 MB LoRA on an unfeatured model: charged on every other ground.
  const charged = async (versionFlags: number) =>
    (
      await getShouldChargeForResources([
        { modelType: 'LORA', modelId: MODEL_ID, fileSizeKB: 200 * 1024, versionFlags },
      ])
    )[MODEL_ID];

  beforeEach(() => {
    vi.mocked(getFeaturedModels).mockResolvedValue([]);
  });

  it('charges an unflagged version', async () => {
    expect(await charged(ModelVersionFlag.None)).toBe(true);
  });

  it('does not charge a version carrying the flag', async () => {
    expect(await charged(ModelVersionFlag.NoAdditionalResourceFee)).toBe(false);
    expect(
      await charged(ModelVersionFlag.NoAdditionalResourceFee | ModelVersionFlag.NotEvictable)
    ).toBe(false);
  });

  // These go through the call site, not the predicate: it builds the predicate's arguments.
  const chargedWith = async (override: { modelType?: 'LORA' | 'VAE'; fileSizeKB?: number }) =>
    (
      await getShouldChargeForResources([
        {
          modelType: 'LORA',
          modelId: MODEL_ID,
          fileSizeKB: 200 * 1024,
          versionFlags: ModelVersionFlag.None,
          ...override,
        },
      ])
    )[MODEL_ID];

  it('does not charge a featured model, but does charge beside a different featured one', async () => {
    vi.mocked(getFeaturedModels).mockResolvedValue([{ modelId: MODEL_ID }] as never);
    expect(await chargedWith({})).toBe(false);
    vi.mocked(getFeaturedModels).mockResolvedValue([{ modelId: MODEL_ID + 1 }] as never);
    expect(await chargedWith({})).toBe(true);
  });

  it('does not charge a free resource type', async () => {
    expect(await chargedWith({ modelType: 'VAE' })).toBe(false);
  });

  it('does not charge a file of 10 MB or less', async () => {
    expect(await chargedWith({ fileSizeKB: 10 * 1024 })).toBe(false);
  });

  // The generator's cost badge treats an unknown size as charged; the orchestrator's charge never has.
  it('does not charge when the file size is unknown', async () => {
    expect(await chargedWith({ fileSizeKB: undefined })).toBe(false);
  });

  it('still charges a version carrying only other flags (bit-confusion guard)', async () => {
    expect(
      await charged(
        ModelVersionFlag.GenerationDisabled |
          ModelVersionFlag.NotDerivative |
          ModelVersionFlag.NotEvictable |
          1
      )
    ).toBe(true);
  });
});

// Both the orchestrator's charge and the generator's cost badge read this predicate.
describe('isAdditionalResourceFeeExempt', () => {
  const largeLora = {
    modelType: 'LORA' as const,
    featured: false,
    versionFlags: ModelVersionFlag.None,
    fileSizeKB: 200 * 1024,
  };

  it('does not exempt a large, unfeatured, unflagged LoRA', () => {
    expect(isAdditionalResourceFeeExempt(largeLora)).toBe(false);
  });

  it.each([
    ['the waiver flag', { versionFlags: ModelVersionFlag.NoAdditionalResourceFee }],
    ['a featured model', { featured: true }],
    ['a free resource type', { modelType: 'VAE' as const }],
    ['a file of 10 MB or less', { fileSizeKB: 10 * 1024 }],
  ])('exempts on %s', (_, override) => {
    expect(isAdditionalResourceFeeExempt({ ...largeLora, ...override })).toBe(true);
  });
});

describe('moderator flag writes', () => {
  const VERSION_ID = 7;
  const MODEL_ID = 70;
  const queryRaw = () => vi.mocked(dbMock.dbWrite.$queryRaw);
  const lastUpdate = () => {
    const query = queryRaw().mock.calls[0]?.[0] as unknown as Prisma.Sql;
    return { sql: query.text.replace(/\s+/g, ' ').trim(), values: query.values };
  };
  const returning = (flags: number) =>
    queryRaw().mockResolvedValueOnce([{ modelId: MODEL_ID, flags }] as never);

  beforeEach(() => {
    queryRaw().mockReset();
    vi.mocked(bustMvCache).mockReset();
  });

  it('toggleGenerationDisabled XORs its bit in one statement', async () => {
    returning(ModelVersionFlag.GenerationDisabled);
    await toggleGenerationDisabled({ id: VERSION_ID, isModerator: true });
    expect(lastUpdate()).toEqual({
      sql: 'UPDATE "ModelVersion" SET flags = flags # $1 WHERE id = $2 RETURNING "modelId", flags',
      values: [ModelVersionFlag.GenerationDisabled, VERSION_ID],
    });
    expect(bustMvCache).toHaveBeenCalledWith(VERSION_ID, MODEL_ID);
  });

  // A toggle sent from a stale menu would clear the pin on a base model; setting the
  // requested value makes a repeated or stale click a no-op instead.
  it.each([
    [
      false,
      'UPDATE "ModelVersion" SET flags = flags | $1 WHERE id = $2 RETURNING "modelId", flags',
    ],
    [
      true,
      'UPDATE "ModelVersion" SET flags = flags & ~($1::int) WHERE id = $2 RETURNING "modelId", flags',
    ],
  ])(
    'setEvictable(%s) sets the bit to the requested state, never flips it',
    async (evictable, sql) => {
      returning(evictable ? 0 : ModelVersionFlag.NotEvictable);
      await setEvictable({ id: VERSION_ID, evictable, isModerator: true });
      expect(lastUpdate()).toEqual({ sql, values: [ModelVersionFlag.NotEvictable, VERSION_ID] });
      expect(bustMvCache).toHaveBeenCalledWith(VERSION_ID, MODEL_ID);
    }
  );

  it.each([
    [true, 'UPDATE "ModelVersion" SET flags = flags | $1 WHERE id = $2 RETURNING "modelId", flags'],
    [
      false,
      'UPDATE "ModelVersion" SET flags = flags & ~($1::int) WHERE id = $2 RETURNING "modelId", flags',
    ],
  ])(
    'setAdditionalResourceFeeWaived(%s) sets the bit to the requested state, never flips it',
    async (waived, sql) => {
      returning(waived ? ModelVersionFlag.NoAdditionalResourceFee : 0);
      expect(
        await setAdditionalResourceFeeWaived({ id: VERSION_ID, waived, isModerator: true })
      ).toEqual({
        id: VERSION_ID,
        waived,
      });
      expect(lastUpdate()).toEqual({
        sql,
        values: [ModelVersionFlag.NoAdditionalResourceFee, VERSION_ID],
      });
      expect(bustMvCache).toHaveBeenCalledWith(VERSION_ID, MODEL_ID);
    }
  );

  it('reports generationDisabled from the returned flags', async () => {
    returning(ModelVersionFlag.GenerationDisabled | ModelVersionFlag.NotEvictable);
    expect(await toggleGenerationDisabled({ id: VERSION_ID, isModerator: true })).toEqual({
      id: VERSION_ID,
      generationDisabled: true,
    });
    returning(ModelVersionFlag.NotEvictable);
    expect(await toggleGenerationDisabled({ id: VERSION_ID, isModerator: true })).toEqual({
      id: VERSION_ID,
      generationDisabled: false,
    });
  });

  it('reports waived from the returned flags, not from the request', async () => {
    returning(ModelVersionFlag.NotEvictable);
    expect(
      await setAdditionalResourceFeeWaived({ id: VERSION_ID, waived: true, isModerator: true })
    ).toEqual({ id: VERSION_ID, waived: false });
    returning(ModelVersionFlag.NoAdditionalResourceFee);
    expect(
      await setAdditionalResourceFeeWaived({ id: VERSION_ID, waived: false, isModerator: true })
    ).toEqual({ id: VERSION_ID, waived: true });
  });

  it('reports evictable from the returned flags', async () => {
    returning(ModelVersionFlag.NotEvictable | ModelVersionFlag.GenerationDisabled);
    expect(await setEvictable({ id: VERSION_ID, evictable: false, isModerator: true })).toEqual({
      id: VERSION_ID,
      evictable: false,
    });
    returning(ModelVersionFlag.GenerationDisabled);
    expect(await setEvictable({ id: VERSION_ID, evictable: true, isModerator: true })).toEqual({
      id: VERSION_ID,
      evictable: true,
    });
  });

  it.each([
    [
      'toggleGenerationDisabled',
      () => toggleGenerationDisabled({ id: VERSION_ID, isModerator: false }),
    ],
    ['setEvictable', () => setEvictable({ id: VERSION_ID, evictable: false, isModerator: false })],
    [
      'setAdditionalResourceFeeWaived',
      () => setAdditionalResourceFeeWaived({ id: VERSION_ID, waived: true, isModerator: false }),
    ],
  ] as const)('%s refuses a non-moderator without writing', async (_, call) => {
    await expect(call()).rejects.toThrow();
    expect(queryRaw()).not.toHaveBeenCalled();
    expect(bustMvCache).not.toHaveBeenCalled();
  });

  it.each([
    [
      'toggleGenerationDisabled',
      () => toggleGenerationDisabled({ id: VERSION_ID, isModerator: true }),
    ],
    ['setEvictable', () => setEvictable({ id: VERSION_ID, evictable: false, isModerator: true })],
    [
      'setAdditionalResourceFeeWaived',
      () => setAdditionalResourceFeeWaived({ id: VERSION_ID, waived: true, isModerator: true }),
    ],
  ] as const)('%s 404s on a missing version and busts nothing', async (_, call) => {
    queryRaw().mockResolvedValueOnce([] as never);
    await expect(call()).rejects.toThrow(`No model version with id ${VERSION_ID}`);
    expect(bustMvCache).not.toHaveBeenCalled();
  });
});
