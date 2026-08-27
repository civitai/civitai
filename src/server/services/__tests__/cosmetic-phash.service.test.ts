import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    cosmeticFindUnique: vi.fn(),
    cosmeticFindMany: vi.fn(),
    cosmeticUpdate: vi.fn(),
    queryRaw: vi.fn(),
    getPerceptualHash: vi.fn(),
    keyValueFindUnique: vi.fn(),
  },
}));

vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  getPerceptualHash: mocks.getPerceptualHash,
}));
import {
  COSMETIC_PHASH_LANE,
  COSMETIC_SIMILARITY_CLOSE_RATIO_KEY,
  getCosmeticSimilarityCloseRatio,
  getSimilarCosmetics,
  hammingDistanceHex,
  legacyBigIntHash,
  markCosmeticHashFailed,
  normalizeCosmeticHashHex,
  queueCosmeticPerceptualHash,
  storeCosmeticPerceptualHash,
} from '../cosmetic-phash.service';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { COSMETIC_SIMILARITY_CLOSE_RATIO } from '~/shared/constants/cosmetic-shop.constants';
dbMock.dbRead.keyValue.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.keyValueFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.cosmetic.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.cosmeticFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.cosmetic.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.cosmeticFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.$queryRaw.mockImplementation((...args: unknown[]) =>
  (mocks.queryRaw as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmetic.update.mockImplementation((...args: unknown[]) =>
  (mocks.cosmeticUpdate as (...a: unknown[]) => unknown)(...args)
);

const LANE = COSMETIC_PHASH_LANE.version;

// Real `perceptualDct256` hashes from the orchestrator, 2026-08-27. Both pairs
// were confirmed by eye: A is a redraw of the official badge, B a near-copy.
const IMITATION_A = {
  official: 'c0cbe486273c1b933ed3ee6c9b111b31ce3eec4e34e603b13199fc44cf2b2199',
  copy: 'c0cbe1e9063c3ff13fc0f6e43b011811645774ee3cee13913198de466f738d98',
};
const IMITATION_B = {
  official: 'dd303ff622cf008d6bfd018d0d40ef0a3f3ffe263f53b1997c0c06667033091b',
  copy: 'c4103f3303efb1197fc0798c3c0384ee383fee6638eb3199610cce662f37ccc6',
};

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

  // Cosmetic 107 (official "Diamond Generator Badge") vs 1426 ("Master Generators
  // (Temu Edition)"), and 870 vs 1251 — two visually confirmed imitations, and the
  // pairs every lane is judged on.
  it('reproduces the measured distance between the two real imitation pairs', () => {
    expect(hammingDistanceHex(IMITATION_A.official, IMITATION_A.copy)).toBe(60);
    expect(hammingDistanceHex(IMITATION_B.official, IMITATION_B.copy)).toBe(82);
  });

  it('refuses to compare across widths instead of returning a number', () => {
    // Two lanes produce independent hashes; a distance between them is noise, and
    // this is the only place that can tell.
    expect(() => hammingDistanceHex('0000000000000001', 'ff')).toThrow(/width mismatch/i);
  });
});

describe('normalizeCosmeticHashHex', () => {
  it('pads a hash the orchestrator returned without leading zeros', () => {
    // Same number, different string — and only the string is ever compared. Spelt
    // out rather than derived from `hexLength`, so a lane bump that forgets to move
    // the width fails here instead of padding every hash to the old one.
    expect(normalizeCosmeticHashHex('E4')).toBe(`${'0'.repeat(62)}e4`);
    expect(normalizeCosmeticHashHex(IMITATION_A.official.toUpperCase())).toBe(IMITATION_A.official);
  });

  // Padding only works in one direction. A hash WIDER than the lane comes back
  // from `padStart` unchanged, so it would be stored at full width stamped with
  // the current version — accepted as a comparison TARGET, then excluded from
  // every candidate set by the length filter. The row looks correctly hashed and
  // reports "nothing was close" forever.
  it('refuses a hash wider than the lane rather than storing it unpadded', () => {
    expect(() => normalizeCosmeticHashHex('a'.repeat(COSMETIC_PHASH_LANE.hexLength + 1))).toThrow(
      /wider than lane/i
    );
  });
});

describe('COSMETIC_PHASH_LANE', () => {
  // The three fields are one fact spelt three ways, and only two of the six wrong
  // combinations announce themselves. A hashType that disagrees with the version
  // labels 64-bit hashes as 256-bit ones; a version left behind labels 256-bit
  // hashes as the old lane, so the sweep considers them current and never re-hashes.
  // Both mix algorithms inside a single `pHashVersion`, which is the one thing every
  // comparison in this file trusts and nothing downstream can detect.
  it('spells the same lane in all three fields', () => {
    expect(COSMETIC_PHASH_LANE.version).toBe(
      `${COSMETIC_PHASH_LANE.hashType}/${COSMETIC_PHASH_LANE.hexLength * 4}`
    );
  });
});

describe('getCosmeticSimilarityCloseRatio', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    // `loggingMock` is reset once per FILE, not per test. Without this a later
    // case satisfies `toHaveBeenCalledWith` on the FIRST case's warning and passes
    // whether or not it warned itself — three of the five below did exactly that.
    loggingMock.logToAxiom.mockClear();
  });

  it('reads the operator-set fraction from the KeyValue row', async () => {
    mocks.keyValueFindUnique.mockResolvedValue({ value: 0.05 });

    await expect(getCosmeticSimilarityCloseRatio()).resolves.toBe(0.05);
    expect(mocks.keyValueFindUnique).toHaveBeenCalledWith({
      where: { key: COSMETIC_SIMILARITY_CLOSE_RATIO_KEY },
    });
  });

  // Not configured is the ordinary state, not a broken one.
  it('falls back to the built-in default when the row is absent', async () => {
    mocks.keyValueFindUnique.mockResolvedValue(null);
    await expect(getCosmeticSimilarityCloseRatio()).resolves.toBe(COSMETIC_SIMILARITY_CLOSE_RATIO);
  });

  // The read itself, not just the value it returns. This is awaited inside
  // `getSimilarCosmetics` AFTER the distances are computed, so an unguarded
  // rejection throws away a finished ranking to avoid mislabelling a badge —
  // the precise trade the fail-direction block claims not to make. Nothing else
  // in the suite notices: every other test resolves this mock.
  it('falls back to the default when the KeyValue read itself rejects', async () => {
    mocks.keyValueFindUnique.mockRejectedValue(new Error('replica unreachable'));

    await expect(getCosmeticSimilarityCloseRatio()).resolves.toBe(COSMETIC_SIMILARITY_CLOSE_RATIO);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'cosmetic-phash' })
    );
  });

  // `KeyValue.value` is a Json column, so every one of these is representable. A
  // throw here would take out the ranking — the part mods use — to fix a badge,
  // so the panel degrades to the measured default instead. Out-of-range values
  // are rejected rather than clamped: clamping 1.5 to 1 would badge every match
  // as near-identical, which reads as a working threshold rather than a refused one.
  it.each([
    ['a string', '0.05'],
    ['an object', { ratio: 0.05 }],
    ['negative', -0.2],
    ['exactly one', 1],
    ['above one', 1.5],
  ])('falls back to the default and warns on %s', async (_label, value) => {
    mocks.keyValueFindUnique.mockResolvedValue({ value });

    await expect(getCosmeticSimilarityCloseRatio()).resolves.toBe(COSMETIC_SIMILARITY_CLOSE_RATIO);
    // Times(1) as well as With(): the matcher alone is satisfied by a previous
    // test's call, which is how three of these stayed green while warning nothing.
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', name: 'cosmetic-phash' })
    );
  });

  // Refusing 0 would fail in the LOOSENING direction: an operator asking for
  // "exact duplicates only" would silently get MORE red badges than they asked
  // for. 1 is refused instead — it badges the entire list, the same degenerate
  // outcome 1.5 is rejected for.
  it('accepts zero, which means only an exact match is near-identical', async () => {
    mocks.keyValueFindUnique.mockResolvedValue({ value: 0 });

    await expect(getCosmeticSimilarityCloseRatio()).resolves.toBe(0);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });
});

describe('legacyBigIntHash', () => {
  it('writes the legacy BIGINT only for the perceptual lane', () => {
    expect(legacyBigIntHash('a6e0c4c4cce8a4b6', 'perceptual')).toBe(BigInt('-6421916719099894602'));
  });

  // `perceptualDct` is ALSO 64 bits, so a width check passes it. `Cosmetic.pHash`
  // has no version column, so DCT values written there would sit beside perceptual
  // ones with nothing able to tell them apart — the cross-lane mixing this file is
  // built to prevent, reintroduced in the one column that cannot describe itself.
  it('writes nothing for another 64-bit lane, which a width check would let through', () => {
    expect(legacyBigIntHash('a6e0c4c4cce8a4b6', 'perceptualDct')).toBeNull();
  });

  it('writes nothing for a wider hash', () => {
    expect(legacyBigIntHash('a'.repeat(64), 'perceptual')).toBeNull();
  });
});

describe('storeCosmeticPerceptualHash', () => {
  beforeEach(() => Object.values(mocks).forEach((m) => m.mockReset()));

  it('records the lane and what was hashed alongside the hash', async () => {
    await storeCosmeticPerceptualHash({
      id: 7,
      url: 'artwork-7',
      hex: IMITATION_A.official.toUpperCase(),
    });

    const { data } = mocks.cosmeticUpdate.mock.calls[0][0];
    expect(data.pHashHex).toBe(IMITATION_A.official);
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

  // `getPerceptualHash` returns undefined for a real failure AND for a workflow
  // still running when the 30s wait elapses; the write path cannot tell them
  // apart. Stamping would put a merely-slow submission behind the sweep's 24h
  // backoff while the panel promises the moderator ~15 minutes.
  it('does not stamp a failure on the write path, where a miss may just be slow', async () => {
    mocks.getPerceptualHash.mockResolvedValue(undefined);

    queueCosmeticPerceptualHash({ id: 12, url: 'artwork-12' });
    await vi.waitFor(() => expect(mocks.getPerceptualHash).toHaveBeenCalled());
    await Promise.resolve();

    expect(mocks.cosmeticUpdate).not.toHaveBeenCalled();
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

  // An empty candidate set is what the corpus looks like for the whole drain
  // after a lane bump. Reported as `ok` it is a green all-clear computed from
  // zero comparisons — a check that cannot fail, handed to a moderator as a pass.
  it('refuses to call an empty corpus a clean comparison', async () => {
    mocks.cosmeticFindUnique.mockResolvedValue(freshTarget('a6e0c4c4cce8a4b6'));
    mocks.queryRaw.mockResolvedValue([]);

    expect(await getSimilarCosmetics({ cosmeticId: 1 })).toEqual({
      status: 'unavailable',
      reason: 'no-corpus',
    });
  });

  // The one link the moderator's badge now hangs on, and nothing else covers it:
  // `close` moved from the component to the server so a runtime-tuned threshold
  // could not disagree with a bundled constant, and the KeyValue read is the only
  // thing that makes it tunable. Replacing the expression with a constant, or
  // dropping the read and using the built-in default, both left the whole suite
  // green before this existed — so the knob was wired to nothing and every test
  // was silently exercising the fallback.
  it('decides `close` on the server and moves it when the operator moves the row', async () => {
    // 64-bit target: default ratio 0.125 => close at or under 8 bits.
    mocks.cosmeticFindUnique.mockResolvedValue(freshTarget('0000000000000001'));
    mocks.queryRaw.mockResolvedValue([
      { id: 2, pHashHex: '0000000000000003' }, // 1 bit away
      { id: 3, pHashHex: 'ffffff0000000001' }, // 24 bits away
    ]);
    mocks.cosmeticFindMany.mockResolvedValue(
      [2, 3].map((id) => ({
        id,
        name: `C${id}`,
        type: 'Badge',
        data: { url: `u${id}` },
        createdById: null,
        creator: null,
        cosmeticShopItems: [],
      }))
    );

    mocks.keyValueFindUnique.mockResolvedValue(null);
    const atDefault = await getSimilarCosmetics({ cosmeticId: 1 });
    expect(atDefault.status).toBe('ok');
    if (atDefault.status !== 'ok') return;
    expect(atDefault.matches.map((m) => [m.distance, m.close])).toEqual([
      [1, true],
      [24, false],
    ]);

    // Operator widens the band to 0.5 => close at or under 32 bits. The 24-bit
    // neighbour has to cross; nothing about the ranking may change with it.
    mocks.keyValueFindUnique.mockResolvedValue({ value: 0.5 });
    const widened = await getSimilarCosmetics({ cosmeticId: 1 });
    expect(widened.status).toBe('ok');
    if (widened.status !== 'ok') return;
    expect(widened.matches.map((m) => [m.distance, m.close])).toEqual([
      [1, true],
      [24, true],
    ]);
  });

  it('reports a real comparison that found nothing as ok, with its count', async () => {
    mocks.cosmeticFindUnique.mockResolvedValue(freshTarget('0000000000000001'));
    // Far from the target, so there is a corpus and nothing near it.
    mocks.queryRaw.mockResolvedValue([{ id: 2, pHashHex: 'ffffffffffffffff' }]);
    mocks.cosmeticFindMany.mockResolvedValue([
      {
        id: 2,
        name: 'Far',
        type: 'Badge',
        data: { url: 'f' },
        createdById: null,
        creator: null,
        cosmeticShopItems: [],
      },
    ]);

    const result = await getSimilarCosmetics({ cosmeticId: 1 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.comparedAgainst).toBe(1);
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
        cosmeticShopItems: [{ status: 'Rejected' }],
      },
      {
        id: 322,
        name: 'Civitwave',
        type: 'Badge',
        data: { url: 'c' },
        createdById: null,
        creator: null,
        cosmeticShopItems: [],
      },
      {
        id: 55,
        name: 'Near',
        type: 'Badge',
        data: { url: 'n' },
        createdById: 7,
        creator: { username: 'other' },
        // Three listings at once (cross-listing/resale). Ordered so that
        // "first one wins" and "last one wins" both produce the WRONG answer —
        // only the precedence rule gives Published.
        cosmeticShopItems: [
          { status: 'Archived' },
          { status: 'Published' },
          { status: 'PendingReview' },
        ],
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

    // Whether the match is on sale is what makes the resemblance actionable, and
    // it is not derivable from anything else on the row. Never-listed (official)
    // must stay distinguishable from listed-but-not-live.
    expect(result.matches.map((m) => [m.id, m.shopStatus])).toEqual([
      [322, null], // official, never listed in a shop
      [55, 'Published'], // live listing outranks its own archived one
      [99, 'Rejected'],
    ]);
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
        pHashHex: (BigInt(i) + BigInt(2)).toString(16).padStart(16, '0'),
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
          cosmeticShopItems: [],
        }))
    );

    const result = await getSimilarCosmetics({ cosmeticId: 1, limit: 10 });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.matches).toHaveLength(10);
    expect(result.comparedAgainst).toBe(300);
  });
});
