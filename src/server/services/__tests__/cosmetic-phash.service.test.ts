import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    cosmeticFindUnique: vi.fn(),
    cosmeticFindMany: vi.fn(),
    cosmeticUpdate: vi.fn(),
    queryRaw: vi.fn(),
    getPerceptualHash: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmetic: { findUnique: mocks.cosmeticFindUnique, findMany: mocks.cosmeticFindMany },
    $queryRaw: mocks.queryRaw,
  },
  dbWrite: { cosmetic: { update: mocks.cosmeticUpdate } },
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  getPerceptualHash: mocks.getPerceptualHash,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));

import {
  COSMETIC_PHASH_LANE,
  getSimilarCosmetics,
  hammingDistanceHex,
  markCosmeticHashFailed,
  normalizeCosmeticHashHex,
  storeCosmeticPerceptualHash,
} from '../cosmetic-phash.service';

const LANE = COSMETIC_PHASH_LANE.version;

// A fresh, comparable target: hashed, in the current lane, and the hash describes
// the artwork the cosmetic actually uses.
const freshTarget = (pHashHex: string, url = 'artwork-1') => ({
  pHashHex,
  pHashUrl: url,
  pHashVersion: LANE,
  data: { url },
});

describe('hammingDistanceHex', () => {
  it('counts differing bits, not differing characters', () => {
    // 0x1 ^ 0x2 = 0b11 — two bits, one character.
    expect(hammingDistanceHex('0000000000000001', '0000000000000002')).toBe(2);
    expect(hammingDistanceHex('ffffffffffffffff', '0000000000000000')).toBe(64);
    expect(hammingDistanceHex('a6e0c4c4cce8a4b6', 'a6e0c4c4cce8a4b6')).toBe(0);
  });

  it('reproduces the measured distance between the two real imitation pairs', () => {
    // Cosmetic 107 (official "Diamond Generator Badge") vs 1426 ("Master
    // Generators (Temu Edition)"), and 870 vs 1251 — the hashes the orchestrator
    // returned on 2026-08-14. These are the numbers the 64-bit lane is judged on.
    expect(hammingDistanceHex('a6e0c4c4cce8a4b6', 'c2a0c460f9cde6b2')).toBe(17);
    expect(hammingDistanceHex('7c337371719d8d8b', 'cc8e33593517cce9')).toBe(22);
  });

  it('refuses to compare across widths instead of returning a number', () => {
    // Two lanes produce independent hashes; a distance between them is noise, and
    // this is the only place that can tell.
    expect(() => hammingDistanceHex('0000000000000001', 'ff')).toThrow(/width mismatch/i);
  });
});

describe('normalizeCosmeticHashHex', () => {
  it('pads a hash the orchestrator returned without leading zeros', () => {
    // Same number, different string — and only the string is ever compared.
    expect(normalizeCosmeticHashHex('E4')).toBe('00000000000000e4');
    expect(normalizeCosmeticHashHex('A6E0C4C4CCE8A4B6')).toBe('a6e0c4c4cce8a4b6');
  });
});

describe('storeCosmeticPerceptualHash', () => {
  beforeEach(() => Object.values(mocks).forEach((m) => m.mockReset()));

  it('records the lane and what was hashed alongside the hash', async () => {
    await storeCosmeticPerceptualHash({ id: 7, url: 'artwork-7', hex: 'A6E0C4C4CCE8A4B6' });

    const { data } = mocks.cosmeticUpdate.mock.calls[0][0];
    expect(data.pHashHex).toBe('a6e0c4c4cce8a4b6');
    expect(data.pHashUrl).toBe('artwork-7');
    expect(data.pHashVersion).toBe(LANE);
  });

  // The sweep skips any row whose `pHashFailedAt` is inside the 24h retry window.
  // Stamping it on SUCCESS would therefore suppress every recently-hashed row for
  // a day — and the rows a lane change most needs re-hashed are exactly the ones
  // hashed most recently. Nothing else in the suite would notice: the sweep still
  // "works", it just silently declines to drain for 24 hours after the bump.
  it('CLEARS the failure stamp on success rather than setting it', async () => {
    await storeCosmeticPerceptualHash({ id: 7, url: 'artwork-7', hex: 'a6e0c4c4cce8a4b6' });

    const { data } = mocks.cosmeticUpdate.mock.calls[0][0];
    expect(data.pHashFailedAt).toBeNull();
  });

  it('stamps the failure time when hashing failed, so dead artwork is suppressed', async () => {
    await markCosmeticHashFailed(240);

    const { where, data } = mocks.cosmeticUpdate.mock.calls[0][0];
    expect(where).toEqual({ id: 240 });
    expect(data.pHashFailedAt).toBeInstanceOf(Date);
    // Only the stamp — a failure must not blank a hash the row already had.
    expect(Object.keys(data)).toEqual(['pHashFailedAt']);
  });
});

describe('getSimilarCosmetics', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.queryRaw.mockResolvedValue([]);
    mocks.cosmeticFindMany.mockResolvedValue([]);
  });

  it('reports WHY nothing was compared rather than returning an empty list', async () => {
    // Each of these renders as a blank panel if it degrades to `matches: []`, and
    // a mod cannot tell a clean comparison from a comparison that never ran.
    mocks.cosmeticFindUnique.mockResolvedValueOnce(null);
    expect(await getSimilarCosmetics({ cosmeticId: 1 })).toEqual({
      status: 'unavailable',
      reason: 'no-hash',
    });

    // Hashed, but in a different lane — the stored value is not comparable.
    mocks.cosmeticFindUnique.mockResolvedValueOnce({
      pHashHex: 'a6e0c4c4cce8a4b6',
      pHashUrl: 'artwork-1',
      pHashVersion: 'perceptualDct/64',
      data: { url: 'artwork-1' },
    });
    expect(await getSimilarCosmetics({ cosmeticId: 1 })).toEqual({
      status: 'unavailable',
      reason: 'no-hash',
    });

    // Artwork was swapped after hashing, so the hash describes an image nobody
    // can see. Matching on it asserts a similarity to something that is gone.
    mocks.cosmeticFindUnique.mockResolvedValueOnce({
      pHashHex: 'a6e0c4c4cce8a4b6',
      pHashUrl: 'artwork-old',
      pHashVersion: LANE,
      data: { url: 'artwork-new' },
    });
    expect(await getSimilarCosmetics({ cosmeticId: 1 })).toEqual({
      status: 'unavailable',
      reason: 'stale-hash',
    });

    // 19 unrelated cosmetics share the all-zero hash in prod; matching on it
    // returns them all and buries anything real.
    mocks.cosmeticFindUnique.mockResolvedValueOnce(freshTarget('0000000000000000'));
    expect(await getSimilarCosmetics({ cosmeticId: 1 })).toEqual({
      status: 'unavailable',
      reason: 'flat-artwork',
    });

    // None of the four reached the candidate query.
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('distinguishes a clean comparison from an absent one', async () => {
    mocks.cosmeticFindUnique.mockResolvedValue(freshTarget('a6e0c4c4cce8a4b6'));
    mocks.queryRaw.mockResolvedValue([]);

    expect(await getSimilarCosmetics({ cosmeticId: 1 })).toEqual({
      status: 'ok',
      comparedAgainst: 0,
      bits: 64,
      matches: [],
    });
  });

  it('orders by distance and puts an exact re-upload first', async () => {
    // Modelled on the live case: cosmetic 1162 is a distance-0 clone of official
    // 322, uploaded separately, and the submission-time sha256 cannot see it
    // because official cosmetics carry no imageHash.
    mocks.cosmeticFindUnique.mockResolvedValue(freshTarget('a6e0c4c4cce8a4b6'));
    mocks.queryRaw.mockResolvedValue([
      { id: 55, pHashHex: 'a6e0c4c4cce8a4b7' }, // 1 bit away
      { id: 322, pHashHex: 'a6e0c4c4cce8a4b6' }, // identical
      { id: 99, pHashHex: '0f1f2f3f4f5f6f7f' }, // unrelated
    ]);
    // Returned in a deliberately unhelpful order — the service must not inherit it.
    mocks.cosmeticFindMany.mockResolvedValue([
      {
        id: 99,
        name: 'Unrelated',
        type: 'Badge',
        data: { url: 'u' },
        createdById: 5,
        creator: { username: 'someone' },
      },
      {
        id: 322,
        name: 'Civitwave',
        type: 'Badge',
        data: { url: 'c' },
        createdById: null,
        creator: null,
      },
      {
        id: 55,
        name: 'Near',
        type: 'Badge',
        data: { url: 'n' },
        createdById: 7,
        creator: { username: 'other' },
      },
    ]);

    const result = await getSimilarCosmetics({ cosmeticId: 1162, limit: 3 });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.matches.map((m) => [m.id, m.distance])).toEqual([
      [322, 0],
      [55, 1],
      [99, 43],
    ]);
    // An official cosmetic has no creator; the panel says so rather than showing
    // a blank byline that reads like a missing username.
    expect(result.matches[0].createdByUsername).toBeNull();
  });

  it('asks the database for same-lane, non-degenerate, non-stale candidates only', async () => {
    mocks.cosmeticFindUnique.mockResolvedValue(freshTarget('a6e0c4c4cce8a4b6'));

    await getSimilarCosmetics({ cosmeticId: 1 });

    // Prisma template tag: strings carry the SQL, values carry the parameters.
    const [strings, ...values] = mocks.queryRaw.mock.calls[0];
    const sql = (strings as unknown as string[]).join('?');
    expect(sql).toContain('"pHashUrl" = data->>\'url\'');
    expect(sql).toContain(`"pHashHex" !~ '^0+$'`);
    expect(values).toContain(LANE);
  });

  it('never returns more than the requested number of neighbours', async () => {
    // The rank limit is the whole reason this is usable: a distance cutoff loose
    // enough to reach a 17-bit match returns a median of 39 rows and up to 192.
    mocks.cosmeticFindUnique.mockResolvedValue(freshTarget('0000000000000001'));
    mocks.queryRaw.mockResolvedValue(
      Array.from({ length: 300 }, (_, i) => ({
        id: i + 2,
        pHashHex: (BigInt(i) + 2n).toString(16).padStart(16, '0'),
      }))
    );
    mocks.cosmeticFindMany.mockImplementation(
      async ({ where }: { where: { id: { in: number[] } } }) =>
        where.id.in.map((id) => ({
          id,
          name: `c${id}`,
          type: 'Badge',
          data: { url: `u${id}` },
          createdById: null,
          creator: null,
        }))
    );

    const result = await getSimilarCosmetics({ cosmeticId: 1, limit: 10 });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.matches).toHaveLength(10);
    expect(result.comparedAgainst).toBe(300);
  });
});
