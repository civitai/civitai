import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type * as PlacementService from '~/server/services/placement.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';

/**
 * The display read of a placement space (`resolvePlacementSpaceForDisplay`, behind
 * `placement-space-read-cache`): the same answer as the primary read, from a cache that each space
 * write busts, with space-row misses filled from the primary and the (uncached) target read from
 * the replica.
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

const { dbs, reads, gate } = vi.hoisted(() => {
  const dbs = {
    primary: { images: [], spaces: [] } as { images: unknown[]; spaces: unknown[] },
    replica: { images: [], spaces: [] } as { images: unknown[]; spaces: unknown[] },
  };
  return {
    dbs,
    reads: [] as { db: string; what: string }[],
    // While set, a space-row read answers from the state it saw on arrival, then waits for this
    // to settle: a fill whose read started before a write and lands after it.
    gate: { rows: null as Promise<void> | null },
  };
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
      const rows = dbOf(client)
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
      if (gate.rows) await gate.rows;
      return rows;
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

/** Past the window in which a just-written row is read from the primary. Literal, not imported. */
const PAST_WRITE_WINDOW_MS = 11_000;
const T0 = new Date('2026-11-06T12:00:00.000Z');
const later = (ms: number) => vi.setSystemTime(new Date(T0.getTime() + ms));

describe('placement space display read: parity with the primary read', () => {
  it('answers what the primary read answers, cold and then from the cache', async () => {
    const truth = await resolvePlacementSpaceFor(TARGET);
    // A guard against a fixture the cascade ignores: the image row's own price governs.
    expect(truth).toMatchObject({ ownerId: OWNER, mode: 'auto', setPrice: 90 });

    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
    const mark = reads.length;
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
    // The warm read took every space row from the cache; only the (uncached) target was read.
    expect(readsSince(mark)).toEqual([{ db: 'replica', what: 'target' }]);
  });

  it('reads the target from the replica and every space-row miss from the primary', async () => {
    await resolvePlacementSpaceForDisplay(TARGET);
    expect(reads).toEqual([
      { db: 'replica', what: 'target' },
      { db: 'primary', what: 'rows' },
    ]);

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

  // 🔴 The sticker flow sends no expected price: what this shows is what the next placement is
  // charged at. A target held in a cache would keep showing the old post's price after the image
  // moved, while the charge read the new one.
  it('follows an image moved to another post on the very next read', async () => {
    const OTHER_POST = 62;
    primary().spaces = [
      space({ entityType: 'user', entityId: OWNER, mode: 'review', price: 120 }),
      space({ entityType: 'post', entityId: OTHER_POST, mode: 'auto', price: 444 }),
    ];
    replicate();
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toMatchObject({ setPrice: 120 });

    primary().images[0].postId = OTHER_POST;
    replicate();

    const truth = await resolvePlacementSpaceFor(TARGET);
    expect(truth).toMatchObject({ mode: 'auto', setPrice: 444 });
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
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

  it('shows a clear at once while the replica lags, and caches the row again once it caught up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await resolvePlacementSpaceForDisplay(TARGET);

    await clearPlacementSpace({
      surface: 'sticker',
      entityType: 'image',
      entityId: IMAGE,
      userId: OWNER,
    });
    // Behind: the replica still has the image row. Inside the write window the row is the primary's.
    const cleared = { mode: 'review', setPrice: 120 };
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toMatchObject(cleared);

    replicate();
    later(PAST_WRITE_WINDOW_MS);
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toMatchObject(cleared);
    const mark = reads.length;
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toMatchObject(cleared);
    expect(readsSince(mark).filter((read) => read.what === 'rows')).toEqual([]);
  });

  // 🔴 The race a plain SET loses: a miss fill reads the row, the row is cleared, and the fill's
  // write lands after the clear. Without the guard that entry is served until it expires.
  it('does not serve a fill that read the replica before a clear and landed after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    let release!: () => void;
    gate.rows = new Promise<void>((resolve) => (release = resolve));
    try {
      // Reads the image row, then stalls before writing it to the cache.
      const stale = resolvePlacementSpaceForDisplay(TARGET);
      await vi.waitFor(() => expect(reads.some((read) => read.what === 'rows')).toBe(true));

      await clearPlacementSpace({
        surface: 'sticker',
        entityType: 'image',
        entityId: IMAGE,
        userId: OWNER,
      });
      replicate();

      gate.rows = null;
      release();
      expect(await stale).toMatchObject({ mode: 'auto', setPrice: 90 }); // what it read, served once
    } finally {
      gate.rows = null;
      release?.();
    }

    // Past the window, so the answer cannot come from the primary read a fresh write gets.
    later(PAST_WRITE_WINDOW_MS);
    const truth = await resolvePlacementSpaceFor(TARGET);
    expect(truth).toMatchObject({ mode: 'review', setPrice: 120 });
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
  });

  // 🔴 An entry is trusted for the whole TTL. A miss filled from a replica still behind a write once
  // the write window has passed would show the pre-write price and mode for that long, while the
  // charge reads the primary's.
  it('fills a miss past the write window from the primary, not a replica still behind the write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    await setPlacementSpace({
      surface: 'sticker',
      entityType: 'image',
      entityId: IMAGE,
      mode: 'off',
      price: 333,
      userId: OWNER,
    });
    // The replica never catches up in this test, and the cache is cold.
    later(PAST_WRITE_WINDOW_MS);

    const truth = await resolvePlacementSpaceFor(TARGET);
    expect(truth).toMatchObject({ mode: 'off', setPrice: 333 });
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
    // What was cached is the primary's row too: the warm read reads no rows and still agrees.
    const mark = reads.length;
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
    expect(readsSince(mark).filter((read) => read.what === 'rows')).toEqual([]);
  });
});

describe('placement space display read: the cache is down', () => {
  it('answers what the primary read answers when the cache cannot be read', async () => {
    await resolvePlacementSpaceForDisplay(TARGET); // warm: the cache holds price 90
    // A change neither the cache nor the replica has seen, so only a primary read can show it.
    primary().spaces = primary().spaces.map((row) =>
      row.entityType === 'image' ? { ...row, price: 777 } : row
    );
    const truth = await resolvePlacementSpaceFor(TARGET);
    expect(truth).toMatchObject({ setPrice: 777 });

    redisMock.redis.packed.mGet.mockRejectedValue(new Error('cache down'));
    const mark = reads.length;
    expect(await resolvePlacementSpaceForDisplay(TARGET)).toEqual(truth);
    expect(readsSince(mark).filter((read) => read.what === 'rows')).toEqual([
      { db: 'primary', what: 'rows' },
    ]);
  });
});

describe('placement space display read: who calls it', () => {
  const SRC = path.resolve(__dirname, '../../..');
  /** Lines that are code, not prose: a comment naming the function calls nothing. */
  const codeLines = (file: string) =>
    readFileSync(path.join(SRC, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

  // 🔴 A ledger, failing if the set GROWS or SHRINKS. The display read takes rows from a cache and
  // the target from a replica, which is only safe for a caller that shows what the primary read would charge; a
  // second caller has to be added here on purpose.
  it('is referenced by exactly one call in the getSpace route and nowhere else', () => {
    const counts: Record<string, number> = {};
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '__tests__') continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          const file = path.relative(SRC, full);
          const n = codeLines(file).filter((line) =>
            line.includes('resolvePlacementSpaceForDisplay')
          ).length;
          if (n) counts[file] = n;
        }
      }
    };
    walk(SRC);
    expect(counts).toEqual({
      // The import and the one call.
      'server/routers/placement.router.ts': 2,
      // The definition.
      'server/services/placement-space.service.ts': 1,
    });

    const routerCalls = codeLines('server/routers/placement.router.ts').filter((line) =>
      /resolvePlacementSpaceForDisplay\s*\(/.test(line)
    );
    expect(routerCalls).toHaveLength(1);
  });
});
