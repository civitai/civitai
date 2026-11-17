import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { getModelsWithImagesAndModelVersions } from '~/server/services/model.service';
import { getImagesForModelVersionCache } from '~/server/services/image.service';
import { getCoverImages } from '~/server/services/model-cover.service';
import { enforceBlockedBrowsingTagsForModels } from '~/server/services/blocked-browsing-tags.service';
import type { SessionUser } from '~/types/session';
import {
  MODEL,
  OWNER,
  VERSION,
  cardImage,
  modelRow,
  resetModelRow,
  stubPackedRedis,
} from './getall-feed-harness';

stubPackedRedis();

vi.mock('~/server/services/image.service', async () =>
  (await import('./getall-feed-harness')).imageServiceModule()
);
vi.mock('~/server/flipt/client', async () =>
  (await import('./getall-feed-harness')).fliptClientModule()
);
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn(),
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: async () => ({
      result: async () => (await import('./getall-feed-harness')).feedModelRows(),
    }),
  },
  pgDbWrite: {},
  pgDbReadLong: {},
}));
vi.mock('~/server/redis/caches', async (importOriginal) =>
  (await import('./getall-feed-harness')).cachesModule(importOriginal)
);
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

const image = (id: number, nsfwLevel: number, extra: { poi?: boolean; minor?: boolean } = {}) =>
  cardImage(id, { nsfwLevel, ...extra });

async function cardImages(
  browsingLevel: number,
  opts: {
    user?: Partial<SessionUser>;
    heldViewer?: boolean;
    disablePoi?: boolean;
    disableMinor?: boolean;
  } = {}
) {
  vi.mocked(enforceBlockedBrowsingTagsForModels).mockImplementation(async (input) => {
    // Stands in for the addon resolution getModelsRaw runs on the viewer's input.
    if (opts.disablePoi) input.disablePoi = true;
    if (opts.disableMinor) input.disableMinor = true;
    return { emptyResult: false };
  });
  const { items } = await getModelsWithImagesAndModelVersions({
    input: { browsingLevel, limit: 10, sort: 'Newest', period: 'AllTime' } as never,
    user: opts.user as SessionUser | undefined,
    heldViewer: opts.heldViewer,
    metricPrivacyEnabled: false,
  });
  return items.find((m) => m.id === MODEL)?.images.map((i) => i.id) ?? [];
}

describe('getModelsWithImagesAndModelVersions card images', () => {
  beforeEach(() => {
    resetModelRow();
    redisMock.redis.get.mockResolvedValue(null);
    vi.mocked(getCoverImages).mockResolvedValue(new Map());
    vi.mocked(getImagesForModelVersionCache).mockResolvedValue({
      [VERSION]: {
        modelVersionId: VERSION,
        images: [image(1, 1), image(4, 4), image(8, 8), image(16, 16)],
      },
    } as never);
  });

  it('sends a signed-out level-1 viewer no image above that level', async () => {
    expect(await cardImages(1)).toEqual([1]);
  });

  it('still sends a level-31 viewer every level', async () => {
    expect(await cardImages(31, { user: { id: 99 } })).toEqual([1, 4, 8, 16]);
  });

  it('keeps an nsfw model up to the viewer highest level, as the client does', async () => {
    modelRow.nsfw = true;
    vi.mocked(getImagesForModelVersionCache).mockResolvedValue({
      [VERSION]: {
        modelVersionId: VERSION,
        images: [image(1, 1), image(2, 2), image(4, 4), image(8, 8)],
      },
    } as never);
    expect(await cardImages(1 | 4, { user: { id: 99 } })).toEqual([1, 2, 4]);
  });

  it('sends a caller that passes no browsing level only public images', async () => {
    expect(await cardImages(undefined as never)).toEqual([1]);
    expect(await cardImages(0)).toEqual([1]);
  });

  describe('a cover found outside the shown images', () => {
    it('is sent when within the viewer level', async () => {
      vi.mocked(getCoverImages).mockResolvedValue(new Map([[MODEL, image(97, 1)]]) as never);
      expect(await cardImages(1)).toEqual([97, 1]);
    });

    it('is dropped above the viewer level, and with no level given', async () => {
      vi.mocked(getCoverImages).mockResolvedValue(new Map([[MODEL, image(99, 8)]]) as never);
      expect(await cardImages(1)).toEqual([1]);
      expect(await cardImages(undefined as never)).toEqual([1]);
    });

    it('is dropped when flagged and the viewer settings hide it', async () => {
      vi.mocked(getCoverImages).mockResolvedValue(
        new Map([[MODEL, image(98, 1, { poi: true })]]) as never
      );
      expect(await cardImages(1, { user: { id: 99 }, disablePoi: true })).toEqual([1]);
    });
  });

  describe('poi and minor flags', () => {
    beforeEach(() => {
      vi.mocked(getImagesForModelVersionCache).mockResolvedValue({
        [VERSION]: {
          modelVersionId: VERSION,
          images: [image(1, 1), image(2, 1, { poi: true }), image(3, 1, { minor: true })],
        },
      } as never);
    });

    it('drops flagged entries when the viewer settings hide them', async () => {
      expect(await cardImages(1, { disablePoi: true, disableMinor: true })).toEqual([1]);
    });

    it('keeps them when the settings do not hide them', async () => {
      expect(await cardImages(1)).toEqual([1, 2, 3]);
    });

    it('keeps them for their owner', async () => {
      expect(
        await cardImages(1, { user: { id: OWNER }, disablePoi: true, disableMinor: true })
      ).toEqual([1, 2, 3]);
    });
  });

  describe('a minor or SFW-only model', () => {
    // Its cached gallery settings: held, at PG|PG13.
    const holdAt = (level: number) =>
      redisMock.redis.get.mockResolvedValue(JSON.stringify({ sfwHeld: true, level }) as never);

    it('serves a level-31 viewer only the images within its hold', async () => {
      modelRow.sfwOnly = true;
      holdAt(1 | 2);
      expect(await cardImages(31, { user: { id: 99 } })).toEqual([1]);
    });

    it('serves its owner the whole showcase', async () => {
      modelRow.minor = true;
      holdAt(1 | 2);
      expect(await cardImages(31, { user: { id: OWNER }, heldViewer: true })).toEqual([
        1, 4, 8, 16,
      ]);
    });

    it('serves a moderator the whole showcase', async () => {
      modelRow.minor = true;
      holdAt(1 | 2);
      expect(
        await cardImages(31, { user: { id: 99, isModerator: true }, heldViewer: true })
      ).toEqual([1, 4, 8, 16]);
    });

    it('holds it for an owner or moderator on a limited credential', async () => {
      modelRow.minor = true;
      holdAt(1 | 2);
      expect(await cardImages(31, { user: { id: OWNER } })).toEqual([1]);
      expect(await cardImages(31, { user: { id: 99, isModerator: true } })).toEqual([1]);
    });

    it('holds it for any other viewer on a full credential', async () => {
      modelRow.minor = true;
      holdAt(1 | 2);
      expect(await cardImages(31, { user: { id: 99 }, heldViewer: true })).toEqual([1]);
    });

    it('serves a moderator a cover found outside the shown images', async () => {
      modelRow.sfwOnly = true;
      holdAt(1 | 2);
      vi.mocked(getCoverImages).mockResolvedValue(new Map([[MODEL, image(99, 8)]]) as never);
      expect(
        await cardImages(31, { user: { id: 5, isModerator: true }, heldViewer: true })
      ).toEqual([99, 1, 4, 8, 16]);
    });

    it('holds a cover found outside the shown images', async () => {
      modelRow.sfwOnly = true;
      holdAt(1 | 2);
      vi.mocked(getCoverImages).mockResolvedValue(new Map([[MODEL, image(99, 8)]]) as never);
      expect(await cardImages(31, { user: { id: 99 } })).toEqual([1]);
    });

    it('keeps that cover for the owner', async () => {
      modelRow.sfwOnly = true;
      holdAt(1 | 2);
      vi.mocked(getCoverImages).mockResolvedValue(new Map([[MODEL, image(99, 8)]]) as never);
      expect(await cardImages(31, { user: { id: OWNER }, heldViewer: true })).toEqual([
        99, 1, 4, 8, 16,
      ]);
    });
  });
});
