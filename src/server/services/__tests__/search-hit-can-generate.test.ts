import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as ImageService from '~/server/services/image.service';
import type * as BlockedBrowsingTags from '~/server/services/blocked-browsing-tags.service';
import { baseModels, isModelLockedBaseModel } from '@civitai/shared/basemodel.constants';
import { feedVersionCanGenerate } from '~/server/services/model.service';
import { coverageAudience } from '~/server/services/generation/coverage-source';
import { isFlipt } from '~/server/flipt/client';
import {
  indexedVersionEligibility,
  searchHitCanGenerate,
} from '~/shared/generation/coverage-fields';
import { isGeneratorReady, type VersionReadiness } from '~/shared/generation/generator-readiness';
import '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn().mockResolvedValue(false),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockedBrowsingTags>()),
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: { cancellableQuery: async () => ({ result: async () => [] }) },
  pgDbWrite: {},
  pgDbReadLong: {},
}));

afterEach(() => {
  vi.mocked(isFlipt).mockResolvedValue(false);
});

type Row = { covered: boolean; coveredNext: boolean; baseModel: string; flags: number };

// The index writers' per-version fields; `no-divergent-generator-readiness` pins the readiness half.
const indexed = (id: number, row: Row, modelType: string, readiness: VersionReadiness) => ({
  id,
  generatorLoaded: isGeneratorReady(readiness),
  ...indexedVersionEligibility({ ...row, generationCoverage: row }, modelType as 'Checkpoint'),
});

const lockedBaseModel = baseModels.find(isModelLockedBaseModel);
// A checkpoint the expansion covers and the live rule does not.
const expansionOnly: Row = { covered: false, coveredNext: true, baseModel: 'SD 1.5', flags: 0 };

function hit(row: Row, type: string, readiness: VersionReadiness) {
  return { type, version: { id: 1 }, versions: [indexed(1, row, type, readiness)] };
}

describe('searchHitCanGenerate', () => {
  // The bug: search read the model-level live field, so this card had no Create while the feed
  // showed one. Pins the absolute answer, which the parity table alone cannot.
  it('gives a member Create on an expansion-only checkpoint', () => {
    expect(
      searchHitCanGenerate(hit(expansionOnly, 'Checkpoint', {}), {
        coverageNext: true,
        member: true,
      })
    ).toBe(true);
  });

  it('judges the version the card opens, not any version', () => {
    expect(
      searchHitCanGenerate(
        {
          type: 'Checkpoint',
          version: { id: 2 },
          versions: [
            indexed(1, { ...expansionOnly, covered: true }, 'Checkpoint', {}),
            indexed(2, { ...expansionOnly, coveredNext: false }, 'Checkpoint', {}),
          ],
        },
        { coverageNext: true, member: true }
      )
    ).toBe(false);
  });

  it('shows no Create when the opened version is not in the hit', () => {
    expect(
      searchHitCanGenerate(
        {
          type: 'Checkpoint',
          version: { id: 2 },
          versions: [indexed(1, { ...expansionOnly, covered: true }, 'Checkpoint', {})],
        },
        { coverageNext: true, member: true }
      )
    ).toBe(false);
  });

  // The reporter's tier is unknown; a signed-out visitor gets the free audience end to end.
  it('gives a signed-out visitor Create only once the checkpoint is ready', async () => {
    vi.mocked(isFlipt).mockImplementation(
      async (flag: string) => flag === 'generation-coverage-next'
    );
    const audience = await coverageAudience(undefined);
    const forViewer = { coverageNext: audience.next, member: audience.member };

    expect(
      searchHitCanGenerate(hit(expansionOnly, 'Checkpoint', { generatorLoaded: false }), forViewer)
    ).toBe(false);
    expect(
      searchHitCanGenerate(hit(expansionOnly, 'Checkpoint', { generatorLoaded: true }), forViewer)
    ).toBe(true);
  });
});

describe('searchHitCanGenerate matches the feed card for the same version and viewer', () => {
  it('has a model-locked base model to cover that branch', () => {
    expect(lockedBaseModel).toBeDefined();
  });

  const bools = [false, true];
  const readinesses: VersionReadiness[] = [
    { generatorLoaded: false },
    { generatorLoaded: true },
    { generatorLoaded: false, usageControl: 'ExternalGeneration' },
  ];
  const cases = bools.flatMap((covered) =>
    bools.flatMap((coveredNext) =>
      ['SD 1.5', lockedBaseModel ?? 'SD 1.5'].flatMap((baseModel) =>
        (['Checkpoint', 'LORA'] as const).flatMap((modelType) =>
          readinesses.flatMap((readiness) =>
            bools.flatMap((next) =>
              bools.map((member) => ({
                row: { covered, coveredNext, baseModel, flags: 0 },
                modelType,
                readiness,
                next,
                member,
              }))
            )
          )
        )
      )
    )
  );

  it.each(cases)(
    'covered=$row.covered next-covered=$row.coveredNext $row.baseModel $modelType ready=$readiness flag=$next member=$member',
    ({ row, modelType, readiness, next, member }) => {
      expect(
        searchHitCanGenerate(hit(row, modelType, readiness), { coverageNext: next, member })
      ).toBe(
        feedVersionCanGenerate({
          version: row,
          modelType,
          next,
          coverage: { next, member },
          readiness,
        })
      );
    }
  );
});
