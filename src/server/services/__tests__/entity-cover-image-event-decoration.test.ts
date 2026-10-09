import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The profile Showcase draws its cards from getEntityCoverImage. Two things decide whether a worn
 * hat shows there: the viewer has to reach getEventDecorationsForEntity (before launch only a
 * flagged viewer sees hats, and a missing viewer reads as signed out), and the hat has to be the
 * showcased entity's own, as on that entity's feed card, not whatever its cover image wears.
 */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

const { decorations } = vi.hoisted(() => ({ decorations: vi.fn() }));
vi.mock('~/server/services/cosmetic.service', () => ({
  getCosmeticsForEntity: vi.fn().mockResolvedValue({}),
  getEventDecorationsForEntity: decorations,
}));

import { getEntityCoverImage } from '../image.service';

const row = (id: number, entityType: string, entityId: number) => ({
  id,
  name: 'x',
  url: 'x',
  nsfwLevel: 1,
  width: 1,
  height: 1,
  hash: 'x',
  hideMeta: false,
  hasMeta: false,
  hasPositivePrompt: false,
  createdAt: new Date(0),
  mimeType: 'image/jpeg',
  type: 'image',
  metadata: null,
  scannedAt: new Date(0),
  needsReview: null,
  userId: 1,
  index: 0,
  postId: null,
  entityId,
  entityType,
});

const hat = (name: string) => ({ id: 1, name, data: { type: 'hat' } });
const WORN: Record<string, Record<number, ReturnType<typeof hat>>> = {
  // Image 11 is the showcased image; image 50 is the model's cover and wears a hat of its own.
  Image: { 11: hat('on image 11'), 50: hat('on the cover image') },
  Model: { 2: hat('on model 2') },
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.$queryRaw.mockResolvedValue([row(11, 'Image', 11), row(50, 'Model', 2)]);
  decorations.mockImplementation(async ({ entity }: { entity: string }) => WORN[entity] ?? {});
});

const entities = [
  { entityType: 'Image', entityId: 11 },
  { entityType: 'Model', entityId: 2 },
];

describe('getEntityCoverImage event decorations', () => {
  it("wears each showcased entity's own hat", async () => {
    const covers = await getEntityCoverImage({ entities });
    expect(covers.map((c) => [c.entityType, c.entityId, c.eventDecoration?.name])).toEqual([
      ['Image', 11, 'on image 11'],
      ['Model', 2, 'on model 2'],
    ]);
  });

  it('asks for the named viewer', async () => {
    await getEntityCoverImage({ entities, eventDecorationViewer: { id: 5 } });
    expect(decorations).toHaveBeenCalledWith(expect.objectContaining({ viewer: { id: 5 } }));
    expect(decorations.mock.calls.every(([arg]) => arg.viewer?.id === 5)).toBe(true);
  });

  it('treats a caller that names no viewer as signed out', async () => {
    await getEntityCoverImage({ entities });
    expect(decorations).toHaveBeenCalled();
    expect(decorations.mock.calls.every(([arg]) => arg.viewer === undefined)).toBe(true);
  });
});
