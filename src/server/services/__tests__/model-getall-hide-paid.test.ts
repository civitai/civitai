import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelsWithImagesAndModelVersions } from '~/server/services/model.service';
import { getImagesForModelVersionCache } from '~/server/services/image.service';
import { getModelPaidAccessGates } from '~/server/services/paid-access.service';
import { getCoverImages } from '~/server/services/model-cover.service';
import type * as Caches from '~/server/redis/caches';
import { MODEL, OWNER, cardImage, stubPackedRedis } from './getall-feed-harness';

/**
 * A model kept by Hide Paid because it has a free version shows that version on its card: the
 * version, its cover images and no Paid chip. Without the filter the card is unchanged.
 */

const PAID = 201; // newest, gated
const FREE = 200; // older, free

stubPackedRedis();

vi.mock('~/server/services/image.service', async () =>
  (await import('./getall-feed-harness')).imageServiceModule()
);
vi.mock('~/server/flipt/client', async () =>
  (await import('./getall-feed-harness')).fliptClientModule()
);
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: async () => ({
      result: async () => (await import('./getall-feed-harness')).feedModelRows(),
    }),
  },
  pgDbWrite: {},
  pgDbReadLong: {},
}));
const version = (id: number) => ({
  id,
  status: 'Published',
  availability: 'Public',
  nsfwLevel: 31,
  baseModel: 'SDXL 1.0',
  flags: 0,
});
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  userBasicCache: { fetch: vi.fn(async () => ({ [OWNER]: { username: 'owner' } })) },
  dataForModelsCache: {
    fetch: vi.fn(async () => ({
      [MODEL]: { versions: [version(PAID), version(FREE)], tags: [], hashes: [] },
    })),
  },
}));
vi.mock('~/server/services/user.service', async (importOriginal) =>
  (await import('./getall-feed-harness')).userServiceModule(importOriginal)
);
vi.mock('~/server/services/cosmetic.service', async (importOriginal) =>
  (await import('./getall-feed-harness')).cosmeticServiceModule(importOriginal)
);
vi.mock('~/server/services/paid-access.service', async (importOriginal) =>
  (await import('./getall-feed-harness')).paidAccessServiceModule(importOriginal)
);
vi.mock('~/server/services/model-cover.service', async () =>
  (await import('./getall-feed-harness')).modelCoverServiceModule()
);
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) =>
  (await import('./getall-feed-harness')).coverageSourceModule(importOriginal)
);

const deadline = new Date(Date.now() + 86_400_000);

beforeEach(() => {
  vi.mocked(getModelPaidAccessGates).mockResolvedValue(
    new Map([[MODEL, { gated: true, earlyAccessDeadline: deadline, versionIds: [PAID] }]])
  );
  vi.mocked(getImagesForModelVersionCache).mockImplementation((async (ids: number[]) =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        { modelVersionId: id, images: [{ ...cardImage(id * 10), modelVersionId: id }] },
      ])
    )) as never);
});

async function card(input: Record<string, unknown>) {
  const { items } = await getModelsWithImagesAndModelVersions({
    input: { browsingLevel: 1, limit: 10, sort: 'Newest', period: 'AllTime', ...input } as never,
    user: undefined,
    metricPrivacyEnabled: false,
  });
  return items.find((m) => m.id === MODEL);
}

describe('model.getAll card under Hide Paid', () => {
  it('shows the free version, its cover and no paid chip', async () => {
    const item = await card({ hidePaid: true });
    expect(item?.version.id).toBe(FREE);
    expect(item?.images.map((i) => i.id)).toEqual([FREE * 10]);
    expect(item?.hasActivePaidAccess).toBe(false);
    expect(item?.earlyAccessDeadline).toBeNull();
    // A cover chosen from the paid version must not be hoisted onto the free version's card.
    expect(vi.mocked(getCoverImages).mock.calls.at(-1)?.[0].sameVersionOnly).toBe(true);
  });

  it('drops a model whose every version is gated', async () => {
    vi.mocked(getModelPaidAccessGates).mockResolvedValue(
      new Map([[MODEL, { gated: true, earlyAccessDeadline: null, versionIds: [PAID, FREE] }]])
    );
    expect(await card({ hidePaid: true })).toBeUndefined();
  });

  it('keeps the newest version and the chip with the filter off', async () => {
    const item = await card({});
    expect(item?.version.id).toBe(PAID);
    expect(item?.images.map((i) => i.id)).toEqual([PAID * 10]);
    expect(item?.hasActivePaidAccess).toBe(true);
    expect(item?.earlyAccessDeadline).toEqual(deadline);
    expect(vi.mocked(getCoverImages).mock.calls.at(-1)?.[0].sameVersionOnly).toBe(false);
  });
});
