import { statementOf } from '~/test-utils/queryRawProjection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as FliptClient from '~/server/flipt/client';
import { dbReadFallbackCounter } from '~/server/prom/client';

/**
 * Which driver the image-delivery lookup uses, by IMAGE_DELIVERY_PG_LOOKUP: on sends the statement
 * to `pgDbRead` (falling back to `pgDbWrite` on an error), off to Prisma's `dbRead` (falling back to
 * `dbWrite`). The pools are checked by IDENTITY — the `this` of the call is the exported pool object
 * itself, `toBe`, so a lookup sent to `pgDbReadLong` or to a pool of its own fails here even though
 * every pool answers the same.
 *
 * The real-Postgres comparison of what the two drivers return is
 * `image-delivery.pg-lookup-parity.pg.test.ts`.
 */

const flag = vi.hoisted(() => ({
  value: false as boolean | null,
  initialised: true,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn((key: string) => (key === 'image-delivery-pg-lookup' ? flag.value : null)),
  getFliptClientSync: vi.fn(() => (flag.initialised ? {} : null)),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: { query: vi.fn() },
  pgDbWrite: { query: vi.fn() },
  pgDbReadLong: { query: vi.fn() },
}));

import { ensureFliptInitialized, isFliptSync } from '~/server/flipt/client';
import { pgDbRead, pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import {
  getCachedImageDeliveryMetadata,
  resetImageDeliveryPgLookupGateForTests,
} from '~/server/services/image-delivery.service';

const URL = 'route/abc.jpeg';
// Distinct in every field, so no assertion passes by one aliasing another.
const ROW = { id: 4321, url: URL, hideMeta: true, type: 'video', mimeType: 'video/mp4' };
const PG_ROW = { id: 8765, url: URL, hideMeta: false, type: 'audio', mimeType: 'audio/ogg' };

const pgRead = vi.mocked(pgDbRead.query);
const pgWrite = vi.mocked(pgDbWrite.query);
const pgReadLong = vi.mocked(pgDbReadLong.query);
const prismaRead = dbMock.dbRead.$queryRaw;
const prismaWrite = dbMock.dbWrite.$queryRaw;
const replicaDown = () => Promise.reject(new Error('replica down'));
const pgResult = (rows: unknown[]) => ({ rows } as never);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.clearAllMocks();
  flag.value = false;
  flag.initialised = true;
  resetImageDeliveryPgLookupGateForTests();
  redisMock.redis.packed.get.mockImplementation(async () => null);
  redisMock.redis.packed.set.mockImplementation(async () => undefined);
  prismaRead.mockImplementation((async () => [ROW]) as never);
  prismaWrite.mockImplementation((async () => [ROW]) as never);
  pgRead.mockImplementation((async () => pgResult([PG_ROW])) as never);
  pgWrite.mockImplementation((async () => pgResult([PG_ROW])) as never);
  pgReadLong.mockImplementation((async () => pgResult([PG_ROW])) as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('image-delivery lookup: driver routing', () => {
  it('off: Prisma dbRead answers, no pg pool is touched', async () => {
    flag.value = false;
    expect(await getCachedImageDeliveryMetadata(URL)).toStrictEqual(ROW);
    expect(prismaRead).toHaveBeenCalledTimes(1);
    expect(prismaWrite).not.toHaveBeenCalled();
    expect(pgRead).not.toHaveBeenCalled();
    expect(pgWrite).not.toHaveBeenCalled();
    expect(pgReadLong).not.toHaveBeenCalled();
  });

  it('on: pgDbRead answers — that exact pool — and Prisma is not touched', async () => {
    flag.value = true;
    expect(await getCachedImageDeliveryMetadata(URL)).toStrictEqual(PG_ROW);
    expect(pgRead).toHaveBeenCalledTimes(1);
    expect(pgRead.mock.contexts[0]).toBe(pgDbRead);
    expect(pgRead).toHaveBeenCalledWith(expect.stringContaining('WHERE url = $1'), [
      URL,
      'NotFound',
    ]);
    expect(pgWrite).not.toHaveBeenCalled();
    expect(pgReadLong).not.toHaveBeenCalled();
    expect(prismaRead).not.toHaveBeenCalled();
    expect(prismaWrite).not.toHaveBeenCalled();
  });

  it('on, replica errors: pgDbWrite — that exact pool — answers after one counted fallback', async () => {
    flag.value = true;
    pgRead.mockImplementation(replicaDown as never);
    expect(await getCachedImageDeliveryMetadata(URL)).toStrictEqual(PG_ROW);
    expect(pgWrite).toHaveBeenCalledTimes(1);
    expect(pgWrite.mock.contexts[0]).toBe(pgDbWrite);
    expect(pgWrite).toHaveBeenCalledWith(expect.stringContaining('WHERE url = $1'), [
      URL,
      'NotFound',
    ]);
    expect(vi.mocked(dbReadFallbackCounter.inc).mock.calls).toEqual([
      [{ entity: 'image', caller: 'imageDelivery' }],
    ]);
    expect(prismaWrite).not.toHaveBeenCalled();
    expect(pgReadLong).not.toHaveBeenCalled();
  });

  it('off, replica errors: Prisma dbWrite answers after one counted fallback', async () => {
    flag.value = false;
    prismaRead.mockImplementation(replicaDown as never);
    expect(await getCachedImageDeliveryMetadata(URL)).toStrictEqual(ROW);
    expect(prismaWrite).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbReadFallbackCounter.inc).mock.calls).toEqual([
      [{ entity: 'image', caller: 'imageDelivery' }],
    ]);
    expect(pgWrite).not.toHaveBeenCalled();
  });

  it('on, replica answers empty: a not-found, and the primary is NOT asked', async () => {
    flag.value = true;
    pgRead.mockImplementation((async () => pgResult([])) as never);
    expect(await getCachedImageDeliveryMetadata(URL)).toBeNull();
    expect(pgWrite).not.toHaveBeenCalled();
    expect(dbReadFallbackCounter.inc).not.toHaveBeenCalled();
  });

  it('on, replica and primary both error: the lookup rejects with the primary error', async () => {
    flag.value = true;
    pgRead.mockImplementation(replicaDown as never);
    pgWrite.mockImplementation((() => Promise.reject(new Error('primary down'))) as never);
    await expect(getCachedImageDeliveryMetadata(URL)).rejects.toThrow('primary down');
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
  });

  it.each<[string, boolean | null, boolean]>([
    ['a missing key on a live client', null, true],
    ['a client that has not initialised', null, false],
  ])('%s reads as off (Prisma)', async (_, value, initialised) => {
    flag.value = value;
    flag.initialised = initialised;
    expect(await getCachedImageDeliveryMetadata(URL)).toStrictEqual(ROW);
    expect(pgRead).not.toHaveBeenCalled();
    expect(ensureFliptInitialized).toHaveBeenCalledTimes(initialised ? 0 : 1);
  });

  it('a throwing flag read reads as off (Prisma)', async () => {
    vi.mocked(isFliptSync).mockImplementationOnce(() => {
      throw new Error('wasm');
    });
    expect(await getCachedImageDeliveryMetadata(URL)).toStrictEqual(ROW);
    expect(pgRead).not.toHaveBeenCalled();
  });
});

describe('image-delivery lookup: the switch costs no per-request Flipt read', () => {
  it('reads Flipt once per 5s window, and a flip takes effect after it', async () => {
    vi.setSystemTime(1_000_000);
    flag.value = true;
    for (let i = 0; i < 20; i++) await getCachedImageDeliveryMetadata(URL);
    expect(vi.mocked(isFliptSync)).toHaveBeenCalledTimes(1);
    expect(pgRead).toHaveBeenCalledTimes(20);

    // Turned off: still on inside the window, off after it.
    flag.value = false;
    vi.setSystemTime(1_004_999);
    await getCachedImageDeliveryMetadata(URL);
    expect(pgRead).toHaveBeenCalledTimes(21);
    expect(prismaRead).not.toHaveBeenCalled();

    vi.setSystemTime(1_005_000);
    await getCachedImageDeliveryMetadata(URL);
    expect(vi.mocked(isFliptSync)).toHaveBeenCalledTimes(2);
    expect(prismaRead).toHaveBeenCalledTimes(1);
    expect(pgRead).toHaveBeenCalledTimes(21);
  });
});

describe('image-delivery lookup: both drivers are handed one statement', () => {
  it('pg receives the text and values of the Prisma.Sql that Prisma receives', async () => {
    flag.value = false;
    await getCachedImageDeliveryMetadata(URL);
    flag.value = true;
    resetImageDeliveryPgLookupGateForTests();
    await getCachedImageDeliveryMetadata(URL);

    const prismaStatement = statementOf(prismaRead.mock.calls[0]);
    expect(pgRead.mock.calls[0]).toEqual([prismaStatement.text, prismaStatement.values]);
    // Placeholders node-pg understands, values in placeholder order.
    expect(prismaStatement.text).toMatch(
      /url = \$1\s+AND NOT \(\s+ingestion = \$2::"ImageIngestionStatus"/
    );
    expect(prismaStatement.values).toEqual([URL, 'NotFound']);
  });
});
