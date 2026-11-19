import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The per-entity frame caches (`cosmeticEntityCaches`) behind FRAME_CACHE_NEGATIVE, through the
 * real cache definition and `getCosmeticsForEntity`, with the cache cluster faked as a store.
 * The frame lookup is a raw query on the PRIMARY (`dbWrite.$queryRaw`); that is what is counted.
 */

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));

const { isFlipt } = await import('~/server/flipt/client');
const { cosmeticEntityCaches } = await import('~/server/redis/caches');
const { getCosmeticsForEntity } = await import('~/server/services/cosmetic.service');

const FRAMELESS = 880_011;
const FRAMED = 880_022;
const FRAME_COSMETIC = 7_301;

let flagOn = false;
// entity id → cosmetic id worn as a frame (the UserCosmetic rows the lookup would find)
let worn = new Map<number, number>();
const queryRaw = dbMock.dbWrite.$queryRaw;

// The ids a frame lookup asked for: the Prisma.join(...) argument of the tagged template.
const idsOf = (values: unknown[]) =>
  values.flatMap((v) =>
    v && typeof v === 'object' && Array.isArray((v as { values?: unknown[] }).values)
      ? ((v as { values: unknown[] }).values as number[])
      : []
  );
const isFrameLookup = (strings: TemplateStringsArray) =>
  strings.join('?').includes(`IS DISTINCT FROM 'string'`);
// The recorded calls of the primary's tagged-template query: [strings, ...values].
const calls = () => queryRaw.mock.calls as unknown as [TemplateStringsArray, ...unknown[]][];
const frameLookups = () => calls().filter((call) => isFrameLookup(call[0]));
const lookedUp = (id: number) =>
  frameLookups().filter((call) => idsOf(call.slice(1)).includes(id)).length;

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  flagOn = false;
  worn = new Map([[FRAMED, FRAME_COSMETIC]]);
  vi.mocked(isFlipt).mockImplementation(async (flag: string) =>
    flag === 'frame-cache-negative' ? flagOn : false
  );
  queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!isFrameLookup(strings)) return [];
    return idsOf(values)
      .filter((id) => worn.has(id))
      .map((id) => ({
        equippedToId: id,
        cosmeticId: worn.get(id),
        userData: null,
        createdById: null,
      }));
  });
  dbMock.dbRead.cosmetic.findMany.mockResolvedValue([
    {
      id: FRAME_COSMETIC,
      name: 'Gold frame',
      type: 'ContentDecoration',
      data: { url: 'frame-gold' },
      source: 'Trophy',
      flags: 0,
    },
  ]);
  dbMock.dbWrite.cosmetic.findMany.mockResolvedValue([
    {
      id: FRAME_COSMETIC,
      name: 'Gold frame',
      type: 'ContentDecoration',
      data: { url: 'frame-gold' },
      source: 'Trophy',
      flags: 0,
    },
  ]);
});

const page = () => getCosmeticsForEntity({ ids: [FRAMELESS, FRAMED], entity: 'Image' });

describe('frame caches: FRAME_CACHE_NEGATIVE', () => {
  it('on: a frameless image is read from the primary once across two requests', async () => {
    flagOn = true;
    const first = await page();
    const second = await page();
    expect(second).toEqual(first);
    expect(Object.keys(first)).toEqual([String(FRAMED)]);
    expect(lookedUp(FRAMELESS)).toBe(1);
  });

  it('off (control): a frameless image is read from the primary on every request', async () => {
    const first = await page();
    const second = await page();
    expect(second).toEqual(first);
    expect(Object.keys(first)).toEqual([String(FRAMED)]);
    expect(lookedUp(FRAMELESS)).toBe(2);
  });

  it('on: the "no frame" marker lives an hour, a frame a day', async () => {
    flagOn = true;
    await page();
    // The cache writes each entry with packed.set(key, value, { EX, NX? }).
    const packedSet = (redisMock.redis as unknown as { packed: { set: Mock } }).packed.set;
    const sets = packedSet.mock.calls as unknown as [
      string,
      unknown,
      { EX?: number; NX?: boolean }
    ][];
    const optionsFor = (id: number) => sets.find(([key]) => key.endsWith(`:Image:${id}`))?.[2];
    expect(optionsFor(FRAMELESS)).toEqual({ EX: 3600, NX: true });
    expect(optionsFor(FRAMED)).toEqual({ EX: 86400 });
  });

  it('on: setting a frame refreshes the entry, so the next request shows it', async () => {
    flagOn = true;
    await page();
    worn.set(FRAMELESS, FRAME_COSMETIC);
    await cosmeticEntityCaches.Image.refresh(FRAMELESS); // what equipping does
    const after = await page();
    expect(Object.keys(after).sort()).toEqual([String(FRAMELESS), String(FRAMED)].sort());
    expect(after[FRAMELESS]).toMatchObject({ id: FRAME_COSMETIC, data: { url: 'frame-gold' } });
  });

  it('turned off, a frame added while the miss was cached shows on the next request', async () => {
    flagOn = true;
    await page();
    worn.set(FRAMELESS, FRAME_COSMETIC);
    flagOn = false;
    const after = await page();
    expect(Object.keys(after).sort()).toEqual([String(FRAMELESS), String(FRAMED)].sort());
  });

  it('on, off, on: a frame fetched while off replaces the old marker, so it stays visible', async () => {
    flagOn = true;
    await page(); // "no frame" marker written
    worn.set(FRAMELESS, FRAME_COSMETIC);
    flagOn = false;
    await page(); // marker ignored; the frame is read and cached by a plain SET
    const packedSet = (redisMock.redis as unknown as { packed: { set: Mock } }).packed.set;
    const sets = packedSet.mock.calls as unknown as [
      string,
      unknown,
      { EX?: number; NX?: boolean }
    ][];
    const frameless = sets.filter(([key]) => key.endsWith(`:Image:${FRAMELESS}`));
    expect(frameless.map(([, , o]) => o)).toEqual([{ EX: 3600, NX: true }, { EX: 86400 }]);
    flagOn = true;
    const after = await page();
    expect(Object.keys(after).sort()).toEqual([String(FRAMELESS), String(FRAMED)].sort());
    expect(lookedUp(FRAMELESS)).toBe(2);
  });
});
