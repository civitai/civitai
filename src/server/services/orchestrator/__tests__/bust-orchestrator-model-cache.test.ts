import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbHelpers from '~/server/db/db-helpers';

vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  getCurrentLSN: vi.fn(async () => '0/ABC'),
}));

import { Air } from '@civitai/orchestration-client';
import { getCurrentLSN } from '~/server/db/db-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import {
  bustOrchestratorModelCache,
  bustOrchestratorScannedFileCache,
  clearOrchestratorForGateChange,
  invalidateOrchestratorVersionsOrThrow,
} from '~/server/services/orchestrator/models';
import type { GateRule } from '~/shared/generation/gates';
import { modelVersionAirSelect } from '~/server/utils/resource-air';

/** The global `@civitai/orchestration-client` stub returns `''` from `Air.stringify`; the AIR is the assertion. */
function installAirCodec() {
  const air = Air as unknown as Record<string, unknown>;
  air.stringify = ({ ecosystem, type, source, id, version, modelFileId }: Record<string, string>) =>
    `urn:air:${ecosystem}:${type}:${source}:${id}@${version}${
      modelFileId ? `+${modelFileId}` : ''
    }`;
}

const diffusionModelCheckpoint = {
  id: 2990235,
  baseModel: 'Anima',
  model: { id: 2438778, type: 'Checkpoint' },
  files: [
    {
      id: 2869903,
      type: 'Diffusion Model',
      visibility: 'Public',
      metadata: { format: 'SafeTensor' },
    },
  ],
};

const fetchMock = vi.fn();

function invalidatedAirs() {
  return fetchMock.mock.calls.map(([url]) => new URL(url as string).pathname.split('/').pop());
}

beforeEach(() => {
  vi.clearAllMocks();
  installAirCodec();
  setEnv({ ORCHESTRATOR_ENDPOINT: 'https://orchestrator.test', ORCHESTRATOR_ACCESS_TOKEN: 'tok' });
  fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
  vi.stubGlobal('fetch', fetchMock);
});

describe('bustOrchestratorModelCache', () => {
  it('reads the columns the generation file is chosen by, from the primary', async () => {
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([diffusionModelCheckpoint]);

    await bustOrchestratorModelCache(2990235);

    // The fixture carries every column, so only the select shows whether visibility and
    // replacedAt actually reach getGenerationFile.
    expect(dbMock.dbWrite.modelVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: modelVersionAirSelect })
    );
  });

  it('invalidates the diffusionmodel AIR a Diffusion Model-only checkpoint generates under', async () => {
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([diffusionModelCheckpoint]);

    await bustOrchestratorModelCache(2990235);

    expect(invalidatedAirs()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/:diffusionmodel:civitai:2438778@2990235$/),
        expect.stringMatching(/:checkpoint:civitai:2438778@2990235$/),
      ])
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends one invalidation when the file kind does not change the AIR', async () => {
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
      {
        ...diffusionModelCheckpoint,
        files: [{ id: 1, type: 'Model', visibility: 'Public', metadata: { format: 'SafeTensor' } }],
      },
    ]);

    await bustOrchestratorModelCache(2990235);

    expect(invalidatedAirs()).toEqual([
      expect.stringMatching(/:checkpoint:civitai:2438778@2990235$/),
    ]);
  });

  // Callers (save paths, auction cron jobs) await this unguarded.
  it('resolves when the version read fails', async () => {
    dbMock.dbWrite.modelVersion.findMany.mockRejectedValue(new Error('db timeout'));

    await expect(bustOrchestratorModelCache(2990235)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves when the LSN read fails', async () => {
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([diffusionModelCheckpoint]);
    vi.mocked(getCurrentLSN).mockRejectedValueOnce(new Error('replica down'));

    await expect(bustOrchestratorModelCache(2990235)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('bustOrchestratorScannedFileCache', () => {
  it('invalidates the exact AIR a file scan resolves', async () => {
    await bustOrchestratorScannedFileCache({
      fileId: 2869903,
      modelVersionId: 2990235,
      modelId: 2438778,
      modelType: 'Checkpoint',
      baseModel: 'Anima',
    });

    expect(invalidatedAirs()).toEqual([
      expect.stringMatching(/:checkpoint:civitai:2438778@2990235\+2869903$/),
    ]);
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get('etag')).toBe('0/ABC');
  });
});

describe('invalidateOrchestratorVersionsOrThrow', () => {
  it('throws when an invalidation fails, where the swallowing bust only logs', async () => {
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([diffusionModelCheckpoint]);
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable' });

    await expect(invalidateOrchestratorVersionsOrThrow([2990235])).rejects.toThrow('503');
    await expect(bustOrchestratorModelCache(2990235)).resolves.toBeUndefined();
  });

  it('throws when the orchestrator is not configured, rather than busting nothing', async () => {
    setEnv({ ORCHESTRATOR_ENDPOINT: '', ORCHESTRATOR_ACCESS_TOKEN: '' });

    await expect(invalidateOrchestratorVersionsOrThrow([2990235])).rejects.toThrow(
      'not configured'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('invalidates every AIR of the versions and returns how many', async () => {
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([diffusionModelCheckpoint]);

    const count = await invalidateOrchestratorVersionsOrThrow([2990235]);

    expect(count).toBe(invalidatedAirs().length);
    expect(count).toBeGreaterThan(0);
  });
});

describe('clearOrchestratorForGateChange', () => {
  const version = (id: number, baseModel = 'Anima') => ({
    ...diffusionModelCheckpoint,
    id,
    baseModel,
    model: { ...diffusionModelCheckpoint.model, id: id + 1 },
  });
  const rule = (over: Partial<GateRule>): GateRule => ({
    id: 'gate',
    name: '',
    availableTo: 'members',
    presentation: 'hidden',
    message: null,
    ecosystems: [],
    workflows: [],
    modelVersionIds: [],
    ...over,
  });
  // A Diffusion Model checkpoint is cleared under two AIRs; the versions are the assertion.
  const clearedVersions = () => [
    ...new Set(invalidatedAirs().map((air) => Number(decodeURIComponent(air!).split('@')[1]))),
  ];

  beforeEach(() => {
    dbMock.dbWrite.modelVersion.findMany.mockImplementation((async (args: {
      where: { id: { in: number[] } };
    }) => args.where.id.in.map((id) => version(id))) as never);
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
  });

  it('clears what the rule named before and after the change', async () => {
    const cleared = await clearOrchestratorForGateChange([
      rule({ modelVersionIds: [11] }),
      rule({ modelVersionIds: [12] }),
    ]);
    expect(cleared).toEqual({ cleared: true, ecosystemsNotCleared: [] });
    expect(clearedVersions().sort()).toEqual([11, 12]);
  });

  it("clears alias versions whose target the rule names, by id or by the target's ecosystem", async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      { id: 21, targetId: 11, targetBaseModel: 'Anima' },
      { id: 22, targetId: 99, targetBaseModel: 'Anima' },
      { id: 23, targetId: 98, targetBaseModel: 'SD 1.5' },
    ] as never);
    const result = await clearOrchestratorForGateChange([
      rule({ modelVersionIds: [11], ecosystems: ['Anima'] }),
    ]);
    expect(clearedVersions().sort()).toEqual([11, 21, 22]);
    // The ecosystem's own versions can't be cleared yet; the moderator is told which.
    expect(result.ecosystemsNotCleared).toEqual(['Anima']);
  });

  it('reports a failed clear so the moderator can retry', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Boom' });
    expect((await clearOrchestratorForGateChange([rule({ modelVersionIds: [11] })])).cleared).toBe(
      false
    );
  });
});
