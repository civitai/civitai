import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type * as PlacementService from '~/server/services/placement.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';

/**
 * The display read of a placement space (`resolvePlacementSpaceForDisplay`, behind
 * `placement-space-read-cache`): the same answer as the primary read, from a cache that each space
 * write busts, with misses on the replica.
 *
 * Two databases stand behind the Kysely reads — a primary and a replica — so a test can hold the
 * replica behind a write and see which one an answer came from. The space writes go through the
 * real `setPlacementSpace` / `clearPlacementSpace`, whose Prisma calls land on the primary.
 */

type Space = {
  surface: string;
  entityType: string;
  entityId: number;
  mode: string;
  price: number | null;
  freeSlots: number | null;
  settings: Record<string, unknown>;
};
type Image = { id: number; userId: number; postId: number | null; type: string; username: string };
type Db = { images: Image[]; spaces: Space[] };

const { dbs, reads } = vi.hoisted(() => {
  const dbs = {
    primary: { images: [], spaces: [] } as { images: unknown[]; spaces: unknown[] },
    replica: { images: [], spaces: [] } as { images: unknown[]; spaces: unknown[] },
  };
  return { dbs, reads: [] as { db: string; what: string }[] };
});

// The real clients, as placement-reads.kysely.test.ts uses them: nothing is executed against them
// (the statements are replaced below), so which one a read was handed says which database answered.
const { kyselyRead, kyselyWrite } = await import('~/server/db/kyselyDb');

type DbName = 'primary' | 'replica';
function nameOf(client: unknown): DbName {
  if (client === kyselyWrite) return 'primary';
  if (client === kyselyRead) return 'replica';
  throw new Error('placement-space display test: a read was handed an unknown client');
}
const dbOf = (client: unknown) => dbs[nameOf(client)] as unknown as Db;

vi.mock('@civitai/db-queries/placement', () => ({
  getImagePlacementTarget: vi.fn(async (client: unknown, id: number) => {
    reads.push({ db: nameOf(client), what: 'target' });
    const image = dbOf(client).images.find((candidate) => candidate.id === id);
    return image ? { ...image } : undefined;
  }),
  getModelPlacementTarget: vi.fn(async () => undefined),
  getChapterPlacementTarget: vi.fn(async () => undefined),
  listPlacementSpacesFor: vi.fn(
    async (
      client: unknown,
      input: { surface: string; levels: { entityType: string; entityId: number }[] }
    ) => {
      reads.push({ db: nameOf(client), what: 'rows' });
      return dbOf(client)
        .spaces.filter(
          (space) =>
            space.surface === input.surface &&
            input.levels.some(
              (level) => level.entityType === space.entityType && level.entityId === space.entityId
            )
        )
        .map(({ entityType, mode, price, freeSlots, settings }) => ({
          entityType,
          mode,
          price,
          freeSlots,
          settings: structuredClone(settings),
        }));
    }
  ),
  countPlacements: vi.fn(async () => 1),
}));
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getKeyValue: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRange: async () => ({ min: 0, max: 400, freeSlotCap: 3, score: 0, tier: 'free' }),
}));

const {
  resolvePlacementSpaceFor,
  resolvePlacementSpaceForDisplay,
  setPlacementSpace,
  clearPlacementSpace,
} = await import('~/server/services/placement-space.service');

// Pairwise distinct, so an answer names the row it came from.
const OWNER = 7;
const IMAGE = 501;
const POST = 61;
const TARGET = { surface: 'sticker' as const, targetType: 'image' as const, targetId: IMAGE };

const space = (over: Partial<Space>): Space => ({
  surface: 'sticker',
  entityType: 'user',
  entityId: OWNER,
  mode: 'review',
  price: 120,
  freeSlots: 2,
  settings: {},
  ...over,
});

const primary = () => dbs.primary as unknown as Db;
const replica = () => dbs.replica as unknown as Db;
/** The replica catches up with the primary. */
const replicate = () => {
  replica().images = structuredClone(primary().images);
  replica().spaces = structuredClone(primary().spaces);
};
const readsSince = (mark: number) => reads.slice(mark);

/** The Prisma writes `setPlacementSpace` / `clearPlacementSpace` make, applied to the primary. */
function wirePrimaryWrites() {
  dbMock.dbWrite.placementSpace.findUnique.mockImplementation((async ({ where }: never) => {
    const key = (where as { surface_entityType_entityId: Space }).surface_entityType_entityId;
    return (
      primary().spaces.find(
        (row) =>
          row.surface === key.surface &&
          row.entityType === key.entityType &&
          row.entityId === key.entityId
      ) ?? null
    );
  }) as never);
  dbMock.dbWrite.placementSpace.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.image.findUnique.mockResolvedValue({ userId: OWNER, postId: POST } as never);
  dbMock.dbWrite.placementSpace.upsert.mockImplementation((async ({
    where,
    create,
    update,
  }: never) => {
    const key = (where as { surface_entityType_entityId: Space }).surface_entityType_entityId;
    const rows = primary().spaces;
    const index = rows.findIndex(
      (row) =>
        row.surface === key.surface &&
        row.entityType === key.entityType &&
        row.entityId === key.entityId
    );
    if (index === -1) rows.push({ ...(create as Space) });
    else rows[index] = { ...rows[index], ...(update as Partial<Space>) };
    return {};
  }) as never);
  dbMock.dbWrite.placementSpace.deleteMany.mockImplementation((async ({ where }: never) => {
    const key = where as Space;
    primary().spaces = primary().spaces.filter(
      (row) =>
        !(
          row.surface === key.surface &&
          row.entityType === key.entityType &&
          row.entityId === key.entityId
        )
    );
    return { count: 1 };
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  installFakeCacheRedis();
  reads.length = 0;
  primary().images = [
    { id: IMAGE, userId: OWNER, postId: POST, type: 'image', username: 'owner-name' },
  ];
  primary().spaces = [
    space({ entityType: 'user', entityId: OWNER, mode: 'review', price: 120, freeSlots: 2 }),
    space({ entityType: 'image', entityId: IMAGE, mode: 'auto', price: 90, freeSlots: null }),
  ];
  replicate();
  wirePrimaryWrites();
});

describe('placement space display read: parity with the primary read', () => {
  it('answers what the primary read answers, cold and then from the cache', async () => {
    const truth = await resolvePlacementSpaceFor(TARGET);
    // A guard against a fixture the cascade ignores: the image row's own price governs.
    expect(truth).toMatchObject({ ownerId: OWNER, mode: 'auto', setPrice: 90 });

    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
    const mark = reads.length;
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
    // The warm read touched neither database for the target or the rows.
    expect(readsSince(mark)).toEqual([]);
  });

  it('reads its misses from the replica and the primary read stays on the primary', async () => {
    await resolvePlacementSpaceForDisplay(TARGET);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((read) => read.db === 'replica')).toBe(true);

    const mark = reads.length;
    await resolvePlacementSpaceFor(TARGET);
    expect(readsSince(mark).length).toBeGreaterThan(0);
    expect(readsSince(mark).every((read) => read.db === 'primary')).toBe(true);
  });

  it('serves an image the replica does not have yet from the primary rather than refusing it', async () => {
    replica().images = [];
    await expect(resolvePlacementSpaceForDisplay(TARGET)).resolves.toEqual(
      await resolvePlacementSpaceFor(TARGET)
    );
  });

  it('refuses a missing image with the primary read’s own refusal', async () => {
    const missing = { ...TARGET, targetId: 999 };
    await expect(resolvePlacementSpaceFor(missing)).rejects.toThrow(
      'placement: that image no longer exists'
    );
    await expect(resolvePlacementSpaceForDisplay(missing)).rejects.toThrow(
      'placement: that image no longer exists'
    );
  });
});

describe('placement space display read: a space write busts it', () => {
  it('shows a write made through setPlacementSpace on the next read, with the replica still behind', async () => {
    await resolvePlacementSpaceForDisplay(TARGET); // warm the cache

    await setPlacementSpace({
      surface: 'sticker',
      entityType: 'image',
      entityId: IMAGE,
      mode: 'off',
      price: 333,
      userId: OWNER,
    });
    // The replica has not seen the write. The owner's next look must still show it.

    const truth = await resolvePlacementSpaceFor(TARGET);
    expect(truth).toMatchObject({ mode: 'off', setPrice: 333 });
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
  });

  it('shows a row opened where the level had none (a cached "no row" is busted too)', async () => {
    primary().spaces = primary().spaces.filter((row) => row.entityType !== 'image');
    replicate();
    await resolvePlacementSpaceForDisplay(TARGET); // caches "no image-level row"

    await setPlacementSpace({
      surface: 'sticker',
      entityType: 'image',
      entityId: IMAGE,
      mode: 'auto',
      price: 275,
      userId: OWNER,
    });

    const truth = await resolvePlacementSpaceFor(TARGET);
    expect(truth).toMatchObject({ mode: 'auto', setPrice: 275 });
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
  });

  it('shows a level cleared through clearPlacementSpace falling back to the account row', async () => {
    await resolvePlacementSpaceForDisplay(TARGET); // warm: the image row governs

    await clearPlacementSpace({
      surface: 'sticker',
      entityType: 'image',
      entityId: IMAGE,
      userId: OWNER,
    });
    replicate();

    const truth = await resolvePlacementSpaceFor(TARGET);
    expect(truth).toMatchObject({ mode: 'review', setPrice: 120 });
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
  });

  it('does not pin a cleared row that a lagging replica still returns', async () => {
    await resolvePlacementSpaceForDisplay(TARGET);

    await clearPlacementSpace({
      surface: 'sticker',
      entityType: 'image',
      entityId: IMAGE,
      userId: OWNER,
    });
    // Behind: the replica still has the image row, and a read now may show it.
    await resolvePlacementSpaceForDisplay(TARGET);
    // Once it catches up, the very next read shows the clear — the lagging answer was not cached.
    replicate();
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toMatchObject({
      mode: 'review',
      setPrice: 120,
    });
  });
});

describe('placement space display read: who calls it', () => {
  // 🔴 A ledger, failing if the set GROWS or SHRINKS. The display read takes rows from a cache and
  // a replica, which is only safe for a caller that decides nothing; a second caller is a decision
  // made against a stale space, so it has to be added here on purpose.
  it('is referenced only by its own service and the public getSpace route', () => {
    const root = path.resolve(__dirname, '../../..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '__tests__') continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
          if (
            readFileSync(full, 'utf8')
              .split('\n')
              // Code, not prose: a comment naming it calls nothing.
              .some(
                (line) =>
                  !/^\s*(\/\/|\*|\/\*)/.test(line) &&
                  line.includes('resolvePlacementSpaceForDisplay')
              )
          )
            hits.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(hits.sort()).toEqual([
      'server/routers/placement.router.ts',
      'server/services/placement-space.service.ts',
    ]);
  });
});
