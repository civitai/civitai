import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbHelpers from '~/server/db/db-helpers';

vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  getCurrentLSN: vi.fn(async () => '0/ABC'),
}));

import { Air } from '@civitai/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { bustOrchestratorModelCache } from '~/server/services/orchestrator/models';
import { modelVersionAirSelect } from '~/server/utils/resource-air';

/** The global `@civitai/client` stub returns `''` from `Air.stringify`; the AIR is the assertion. */
function installAirCodec() {
  const air = Air as unknown as Record<string, unknown>;
  air.stringify = ({ ecosystem, type, source, id, version }: Record<string, string>) =>
    `urn:air:${ecosystem}:${type}:${source}:${id}@${version}`;
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
});
