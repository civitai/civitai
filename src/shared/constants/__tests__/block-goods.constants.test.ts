import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  BLOCK_GOOD_APP_OWNER_SHARE,
  BLOCK_GOOD_DEFAULT_KIND,
  BLOCK_GOOD_KINDS,
  BLOCK_GOOD_MAX_PER_MANIFEST,
  BLOCK_GOOD_ID_MAX_LENGTH,
  BLOCK_GOOD_MAX_PRICE_BUZZ,
  BLOCK_GOOD_MIN_PRICE_BUZZ,
  BLOCK_GOOD_PAYLOAD_MAX_BYTES,
  blueLegOfPayout,
  computeBlockGoodSplit,
  findManifestGood,
  isBlockGoodKind,
  parseManifestGoods,
} from '../block-goods.constants';
import {
  computeCreatorShopSplit,
  CREATOR_SHOP_CREATOR_SHARE,
} from '~/server/schema/creator-shop.schema';

/**
 * The DIGITAL GOODS contract: the split arithmetic, the manifest catalog rules,
 * and the lockstep between those rules and the published JSON schema.
 *
 * 🔴 Fixture prices are chosen so they are PAIRWISE DISTINCT and distinct from
 * every constant an assertion names. A price whose split happens to equal the
 * share, the floor or the cap cannot see a mutant that returns that literal.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'public/schemas/app-block/v1.json');

type GoodsSchema = {
  maxItems: number;
  items: {
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: Record<
      string,
      { type?: string; enum?: string[]; minimum?: number; maximum?: number; maxLength?: number }
    >;
  };
  type: string;
};

function goodsProperty(): GoodsSchema {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
    properties: { goods: GoodsSchema };
  };
  return schema.properties.goods;
}

function manifestWith(goods: unknown) {
  return { goods } as { goods?: unknown };
}

const VALID_GOOD = {
  id: 'extra-slots',
  title: 'Extra slots',
  description: 'Five more save slots.',
  priceBuzz: 1300,
  payload: { slots: 5 },
};

describe('computeBlockGoodSplit — the 70/30 arithmetic', () => {
  it('gives the app owner 70% and the platform the rest on an exactly-divisible price', () => {
    // 1000 * 0.7 = 700 exactly. Distinct from the share (0.7), the floor (2) and
    // the cap (50_000).
    expect(computeBlockGoodSplit(1000)).toEqual({ appOwnerShare: 700, platformShare: 300 });
  });

  it('FLOORS the owner share and gives the platform the remainder, so the parts still sum', () => {
    // 999 * 0.7 = 699.3 -> 699 owner, 300 platform. Neither part is 70% or 30%
    // of the price on the nose, which is the case a naive `price * 0.3` gets
    // wrong (it would give 299.7 -> 299 and lose a Buzz).
    const split = computeBlockGoodSplit(999);
    expect(split).toEqual({ appOwnerShare: 699, platformShare: 300 });
    expect(split.appOwnerShare + split.platformShare).toBe(999);
    expect(split.platformShare).not.toBe(Math.floor(999 * (1 - BLOCK_GOOD_APP_OWNER_SHARE)));
  });

  it('CONSERVES the price at every whole value across the legal range', () => {
    // The property the database CHECK enforces. Swept rather than sampled, so a
    // rounding mutant cannot hide between two chosen prices.
    for (let price = BLOCK_GOOD_MIN_PRICE_BUZZ; price <= 3000; price++) {
      const { appOwnerShare, platformShare } = computeBlockGoodSplit(price);
      expect(appOwnerShare + platformShare, `price ${price}`).toBe(price);
      expect(appOwnerShare).toBeGreaterThanOrEqual(0);
      expect(platformShare).toBeGreaterThanOrEqual(0);
    }
  });

  it('never rounds the owner UP — the platform is never short', () => {
    for (const price of [3, 7, 11, 101, 1009, 49_999]) {
      const { appOwnerShare } = computeBlockGoodSplit(price);
      expect(appOwnerShare, `price ${price}`).toBeLessThanOrEqual(
        price * BLOCK_GOOD_APP_OWNER_SHARE
      );
    }
  });

  it('pays the owner at least 1 Buzz at the MINIMUM legal price — the reason the floor is not 1', () => {
    // INVARIANT GUARD, not a regression test: no shipped code ever priced a good
    // at 1. It pins the reason `BLOCK_GOOD_MIN_PRICE_BUZZ` is derived from the
    // share instead of written as `1`.
    expect(computeBlockGoodSplit(BLOCK_GOOD_MIN_PRICE_BUZZ).appOwnerShare).toBeGreaterThanOrEqual(
      1
    );
    expect(computeBlockGoodSplit(BLOCK_GOOD_MIN_PRICE_BUZZ - 1).appOwnerShare).toBe(0);
  });
});

describe('blueLegOfPayout — the proportional blue/yellow split', () => {
  it('pays back nothing in blue when the buyer paid none', () => {
    expect(blueLegOfPayout({ recipientAmount: 700, bluePaid: 0, priceBuzz: 1000 })).toBe(0);
  });

  it('pays the whole recipient amount in blue when the buyer paid entirely in blue', () => {
    expect(blueLegOfPayout({ recipientAmount: 700, bluePaid: 1000, priceBuzz: 1000 })).toBe(700);
  });

  it('prorates a MIXED payment and floors, so the blue leg can never exceed its share', () => {
    // 400 of 1000 paid blue, owner share 700 -> floor(700 * 400 / 1000) = 280,
    // leaving 420 in the domain colour. Every number here is distinct from every
    // other, and from 0.7 / 0.4.
    const blue = blueLegOfPayout({ recipientAmount: 700, bluePaid: 400, priceBuzz: 1000 });
    expect(blue).toBe(280);
    expect(700 - blue).toBe(420);
  });

  it('floors rather than rounds — a fractional proration never over-pays blue', () => {
    // floor(699 * 500 / 999) = floor(349.849…) = 349, not 350.
    const blue = blueLegOfPayout({ recipientAmount: 699, bluePaid: 500, priceBuzz: 999 });
    expect(blue).toBe(349);
    expect(blue).toBeLessThan(Math.round((699 * 500) / 999));
  });

  it('returns 0 for a zero price rather than dividing by zero', () => {
    expect(blueLegOfPayout({ recipientAmount: 5, bluePaid: 3, priceBuzz: 0 })).toBe(0);
  });
});

describe('parseManifestGoods — the review-gated catalog rules', () => {
  it('accepts a manifest with no goods key at all (every app today)', () => {
    expect(parseManifestGoods({})).toEqual({ goods: [], errors: [] });
  });

  it('accepts a well-formed entry and defaults kind + payload', () => {
    const { goods, errors } = parseManifestGoods(manifestWith([VALID_GOOD]));
    expect(errors).toEqual([]);
    expect(goods).toEqual([
      {
        id: 'extra-slots',
        title: 'Extra slots',
        description: 'Five more save slots.',
        priceBuzz: 1300,
        kind: BLOCK_GOOD_DEFAULT_KIND,
        payload: { slots: 5 },
      },
    ]);
  });

  it('REJECTS a duplicate good id', () => {
    const { goods, errors } = parseManifestGoods(
      manifestWith([VALID_GOOD, { ...VALID_GOOD, title: 'Also extra slots', priceBuzz: 2600 }])
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicates an earlier good id');
    // The FIRST wins and the second is dropped, so nothing is sellable at two
    // prices — but the manifest carries an error, so it is not sellable at all.
    expect(goods).toHaveLength(1);
  });

  it('REJECTS a non-integer price', () => {
    const { errors } = parseManifestGoods(manifestWith([{ ...VALID_GOOD, priceBuzz: 12.5 }]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('priceBuzz');
  });

  it('REJECTS a negative and a zero price', () => {
    for (const priceBuzz of [-500, 0]) {
      const { errors } = parseManifestGoods(manifestWith([{ ...VALID_GOOD, priceBuzz }]));
      expect(errors, `price ${priceBuzz}`).toHaveLength(1);
    }
  });

  it('REJECTS a price BELOW the floor and ACCEPTS the floor itself', () => {
    expect(
      parseManifestGoods(
        manifestWith([{ ...VALID_GOOD, priceBuzz: BLOCK_GOOD_MIN_PRICE_BUZZ - 1 }])
      ).errors
    ).toHaveLength(1);
    expect(
      parseManifestGoods(manifestWith([{ ...VALID_GOOD, priceBuzz: BLOCK_GOOD_MIN_PRICE_BUZZ }]))
        .errors
    ).toEqual([]);
  });

  it('REJECTS a price OVER the cap and ACCEPTS the cap itself', () => {
    expect(
      parseManifestGoods(
        manifestWith([{ ...VALID_GOOD, priceBuzz: BLOCK_GOOD_MAX_PRICE_BUZZ + 1 }])
      ).errors
    ).toHaveLength(1);
    expect(
      parseManifestGoods(manifestWith([{ ...VALID_GOOD, priceBuzz: BLOCK_GOOD_MAX_PRICE_BUZZ }]))
        .errors
    ).toEqual([]);
  });

  it('REJECTS a malformed id', () => {
    for (const id of ['Has-Caps', '-leading-dash', 'has space', 'has:colon', '']) {
      const { errors } = parseManifestGoods(manifestWith([{ ...VALID_GOOD, id }]));
      expect(errors, `id ${JSON.stringify(id)}`).toHaveLength(1);
    }
  });

  it('REJECTS an id that would break the redis/ledger key shape', () => {
    // The purchase key is `block-good:<app>:<good>:<user>` and the idempotency
    // key is colon-separated too, so a colon in an id would make two distinct
    // triples collide on one string.
    expect(parseManifestGoods(manifestWith([{ ...VALID_GOOD, id: 'a:b' }])).errors).toHaveLength(1);
  });

  it('accepts an id at EXACTLY the max length and rejects one over it', () => {
    // 🔴 `BLOCK_GOOD_ID_MAX_LENGTH` was ORNAMENTAL: the bound lived only in the
    // regex's `{0,63}` and the constant was read only by an error-message
    // template. So `{0,200}` passed every test while the published schema — which
    // the Go CLI and the SDK byte-mirror — still said 64, and a 200-character id
    // would have flowed into a redis key and a ledger external id.
    const atCap = 'a'.repeat(BLOCK_GOOD_ID_MAX_LENGTH);
    expect(parseManifestGoods(manifestWith([{ ...VALID_GOOD, id: atCap }])).errors).toEqual([]);
    expect(
      parseManifestGoods(manifestWith([{ ...VALID_GOOD, id: `${atCap}a` }])).errors
    ).toHaveLength(1);
  });

  it('REJECTS an empty or over-long title', () => {
    expect(parseManifestGoods(manifestWith([{ ...VALID_GOOD, title: '   ' }])).errors).toHaveLength(
      1
    );
    expect(
      parseManifestGoods(manifestWith([{ ...VALID_GOOD, title: 'x'.repeat(81) }])).errors
    ).toHaveLength(1);
  });

  it('REJECTS an over-long description', () => {
    expect(
      parseManifestGoods(manifestWith([{ ...VALID_GOOD, description: 'x'.repeat(501) }])).errors
    ).toHaveLength(1);
  });

  it('REJECTS an unknown kind and accepts the declared ones', () => {
    expect(
      parseManifestGoods(manifestWith([{ ...VALID_GOOD, kind: 'subscription' }])).errors
    ).toHaveLength(1);
    for (const kind of BLOCK_GOOD_KINDS) {
      const { goods, errors } = parseManifestGoods(manifestWith([{ ...VALID_GOOD, kind }]));
      expect(errors, kind).toEqual([]);
      expect(goods[0].kind).toBe(kind);
    }
  });

  it('REJECTS a payload that is not an object, and one over the byte cap', () => {
    expect(
      parseManifestGoods(manifestWith([{ ...VALID_GOOD, payload: ['not', 'an', 'object'] }])).errors
    ).toHaveLength(1);
    const oversized = { blob: 'x'.repeat(BLOCK_GOOD_PAYLOAD_MAX_BYTES) };
    expect(
      parseManifestGoods(manifestWith([{ ...VALID_GOOD, payload: oversized }])).errors
    ).toHaveLength(1);
  });

  it('ACCEPTS a payload at EXACTLY the byte cap', () => {
    // Boundary control. A `>` -> `>=` mutant survives an over-cap-only test, and
    // its consequence is not local: `findManifestGood` is all-or-nothing, so a
    // payload landing exactly on the cap would make the app's ENTIRE catalog
    // unsellable, not just that entry. `{"blob":""}` is 11 bytes of envelope, so
    // the count is asserted rather than assumed — a wrong envelope size would
    // make this a near-cap test instead of an at-cap one.
    const exact = { blob: 'x'.repeat(BLOCK_GOOD_PAYLOAD_MAX_BYTES - 11) };
    expect(new TextEncoder().encode(JSON.stringify(exact)).length).toBe(
      BLOCK_GOOD_PAYLOAD_MAX_BYTES
    );
    expect(parseManifestGoods(manifestWith([{ ...VALID_GOOD, payload: exact }])).errors).toEqual(
      []
    );
  });

  it('REJECTS more entries than the per-manifest cap, and accepts exactly the cap', () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...VALID_GOOD, id: `good-${i}` }));
    expect(parseManifestGoods(manifestWith(make(BLOCK_GOOD_MAX_PER_MANIFEST))).errors).toEqual([]);
    expect(
      parseManifestGoods(manifestWith(make(BLOCK_GOOD_MAX_PER_MANIFEST + 1))).errors
    ).toHaveLength(1);
  });

  it('REJECTS a non-array goods value and a non-object entry', () => {
    expect(parseManifestGoods(manifestWith({ id: 'x' })).errors).toHaveLength(1);
    expect(parseManifestGoods(manifestWith(['nope'])).errors).toHaveLength(1);
  });
});

describe('findManifestGood — what the purchase path may sell', () => {
  it('finds a declared good by id', () => {
    expect(findManifestGood(manifestWith([VALID_GOOD]), 'extra-slots')?.priceBuzz).toBe(1300);
  });

  it('returns null for an id the manifest does not declare', () => {
    expect(findManifestGood(manifestWith([VALID_GOOD]), 'not-declared')).toBeNull();
  });

  it('returns null for EVERY good when the catalog has ANY error', () => {
    // 🔴 The load-bearing case. A manifest that no longer validates must sell
    // NOTHING — including the entries that are individually fine — rather than
    // charging for a catalog the current rules would reject.
    const broken = manifestWith([VALID_GOOD, { ...VALID_GOOD, id: 'over', priceBuzz: 10_000_000 }]);
    expect(findManifestGood(broken, 'extra-slots')).toBeNull();
    expect(findManifestGood(broken, 'over')).toBeNull();
  });
});

describe('isBlockGoodKind', () => {
  it('accepts the declared kinds and nothing else', () => {
    for (const kind of BLOCK_GOOD_KINDS) expect(isBlockGoodKind(kind)).toBe(true);
    for (const value of ['', 'GOOD', 'app-unlock', 0, null, undefined, {}]) {
      expect(isBlockGoodKind(value), String(value)).toBe(false);
    }
  });
});

describe('the cosmetic-shop agreement guard', () => {
  it('the goods share EQUALS the creator-shop share today', () => {
    // 🔴 WHY THIS ASSERTION EXISTS AND WHY IT IS NOT AN ALIAS. The two constants
    // are deliberately INDEPENDENT knobs: aliasing them would make a creator-shop
    // repricing silently reprice every app's catalog, in a different product,
    // with no review. But "the same cut as cosmetic shop item sales" is a claim
    // the product makes, and with two independent constants and no guard it goes
    // false silently the first time either side moves.
    //
    // 🔴 IF YOU ARE DELIBERATELY DIVERGING THEM, CHANGE THIS TEST IN THE SAME
    // COMMIT and say which product moved. A failure here is a decision to make,
    // not a bug to patch — it is the only place the agreement is written down.
    expect(BLOCK_GOOD_APP_OWNER_SHARE).toBe(CREATOR_SHOP_CREATOR_SHARE);
  });

  it('both split functions apply the SAME rounding rule to the same price', () => {
    // The stronger half: equal constants are not enough if one floors the
    // recipient and the other floors the platform. 999 is the price where those
    // two rules disagree (699/300 vs 699/299), so it discriminates.
    const goods = computeBlockGoodSplit(999);
    const creator = computeCreatorShopSplit(999);
    expect(goods.appOwnerShare).toBe(creator.creatorPool);
    expect(goods.platformShare).toBe(creator.platformCut);
  });
});

describe('published schema ⇄ constants drift guard', () => {
  // The canonical schema is byte-mirrored into the Go CLI and the app SDK, so a
  // bound written in one place and not the other means local validation
  // green-lights a manifest submit rejects (or the reverse).
  it('the schema declares a goods array (positive control on the read)', () => {
    const goods = goodsProperty();
    expect(goods).toBeDefined();
    expect(goods.type).toBe('array');
    expect(goods.items.type).toBe('object');
  });

  it('price bounds match BLOCK_GOOD_MIN_PRICE_BUZZ / BLOCK_GOOD_MAX_PRICE_BUZZ', () => {
    const price = goodsProperty().items.properties.priceBuzz;
    expect(price.type).toBe('integer');
    expect(price.minimum).toBe(BLOCK_GOOD_MIN_PRICE_BUZZ);
    expect(price.maximum).toBe(BLOCK_GOOD_MAX_PRICE_BUZZ);
  });

  it('maxItems matches BLOCK_GOOD_MAX_PER_MANIFEST', () => {
    expect(goodsProperty().maxItems).toBe(BLOCK_GOOD_MAX_PER_MANIFEST);
  });

  it('the kind enum matches BLOCK_GOOD_KINDS exactly, in order', () => {
    expect(goodsProperty().items.properties.kind.enum).toEqual([...BLOCK_GOOD_KINDS]);
  });

  it('id / title / description length bounds match the parser', () => {
    const props = goodsProperty().items.properties;
    // The CONSTANT, not the literal 64 — otherwise the assertion pins the schema
    // to a number the parser is free to walk away from.
    expect(props.id.maxLength).toBe(BLOCK_GOOD_ID_MAX_LENGTH);
    expect(props.title.maxLength).toBe(80);
    expect(props.description.maxLength).toBe(500);
  });

  it('the schema requires exactly the fields the parser requires', () => {
    expect([...goodsProperty().items.required].sort()).toEqual(['id', 'priceBuzz', 'title']);
    // `additionalProperties: false` is what keeps a typo'd key from being
    // silently accepted locally and then ignored by the server.
    expect(goodsProperty().items.additionalProperties).toBe(false);
  });
});
