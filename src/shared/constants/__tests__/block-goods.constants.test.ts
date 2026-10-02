import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  BLOCK_APP_UNLOCK_MAX_PER_MANIFEST,
  BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ,
  BLOCK_GOOD_APP_OWNER_SHARE,
  BLOCK_GOOD_DEFAULT_KIND,
  BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH,
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
  maxPriceBuzzForKind,
  parseManifestGoods,
} from '../block-goods.constants';
import {
  computeCreatorShopSplit,
  CREATOR_SHOP_CREATOR_SHARE,
} from '~/server/schema/creator-shop.schema';
import { buzzConstants } from '~/shared/constants/buzz.constants';
// Read as TEXT rather than imported: `block-tip-rate-limit` pulls in the redis
// client at module scope, and this suite is a pure client-safe constants test.
// The read is asserted (see the guard) so a failed parse fails LOUDLY instead of
// yielding undefined and quietly passing.
import { readFileSync as readTipSource } from 'fs';

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
      {
        type?: string;
        enum?: string[];
        minimum?: number;
        maximum?: number;
        minLength?: number;
        maxLength?: number;
        description?: string;
      }
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
    // The purchase key is `block-good:<app>:<good>:<user>:buy` and the
    // idempotency key is colon-separated too, so a colon in an id would make
    // two distinct triples collide on one string. It is also half of the
    // prefix-freedom argument in `blockGoodPurchaseKey`: that proof holds only
    // because no variable segment can contain the separator.
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
      // 🔴 A KIND MAY CARRY RULES OF ITS OWN, so the fixture supplies what each
      // kind requires rather than asserting one shape satisfies all of them.
      // `app_unlock` requires a `justification` (it turns the app paid) and is
      // capped at BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ — see the dedicated describe
      // block below, which is where those rules are actually pinned. This case
      // remains about the KIND VOCABULARY only: every declared kind is accepted,
      // every undeclared one is not.
      const extras =
        kind === 'app_unlock' ? { justification: 'Covers the per-session GPU cost.' } : {};
      const { goods, errors } = parseManifestGoods(
        manifestWith([{ ...VALID_GOOD, kind, ...extras }])
      );
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

describe('app_unlock — the paid-app bounds, arity and review trigger', () => {
  /**
   * 🔴 FIXTURE NOTE. The unlock price here (3,100) is PAIRWISE DISTINCT from every
   * constant an assertion in this file names — the general cap (50,000), the unlock
   * cap (5,000), the floor (2), `VALID_GOOD`'s 1,300 — so a mutant that hardcodes
   * any one of them cannot survive by coincidence. It is also strictly between the
   * floor and the unlock cap, so it is legal under the narrow bound and says
   * nothing about either boundary on its own; the boundaries get their own cases.
   */
  const VALID_UNLOCK = {
    id: 'full-access',
    title: 'Full access',
    priceBuzz: 3_100,
    kind: 'app_unlock' as const,
    justification: 'The app costs us GPU time per session; this covers it once per user.',
  };

  it('accepts a well-formed app_unlock good', () => {
    const { goods, errors } = parseManifestGoods(manifestWith([VALID_UNLOCK]));
    expect(errors).toEqual([]);
    expect(goods).toHaveLength(1);
    expect(goods[0].kind).toBe('app_unlock');
    expect(goods[0].justification).toBe(VALID_UNLOCK.justification);
  });

  it('REJECTS an app_unlock good ABOVE the unlock cap and ACCEPTS the cap itself', () => {
    // The headline bound. 5,001 is rejected even though it is far BELOW the general
    // BLOCK_GOOD_MAX_PRICE_BUZZ — which is the whole point: before this rule the
    // same entry was accepted at anything up to 50,000.
    const over = parseManifestGoods(
      manifestWith([{ ...VALID_UNLOCK, priceBuzz: BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ + 1 }])
    );
    expect(over.errors).toHaveLength(1);
    expect(over.errors[0]).toContain('priceBuzz');
    expect(over.goods).toHaveLength(0);
    expect(
      parseManifestGoods(
        manifestWith([{ ...VALID_UNLOCK, priceBuzz: BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ }])
      ).errors
    ).toEqual([]);
  });

  it('applies the unlock cap ONLY to app_unlock — an ordinary good keeps the general cap', () => {
    // 🔴 THE DISCRIMINATING CONTROL, and the reason the previous case proves
    // anything. A mutant that simply lowered BLOCK_GOOD_MAX_PRICE_BUZZ to 5,000 for
    // EVERY kind would pass the case above; it dies here. Same price, same
    // manifest, different `kind` — the only variable is the one under test.
    const price = BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ + 1;
    expect(
      parseManifestGoods(manifestWith([{ ...VALID_GOOD, priceBuzz: price }])).errors
    ).toEqual([]);
    expect(
      parseManifestGoods(manifestWith([{ ...VALID_UNLOCK, priceBuzz: price }])).errors
    ).toHaveLength(1);
  });

  it('REJECTS more than one app_unlock good, and accepts exactly one', () => {
    // Two individually-VALID unlocks. The rejection is about the ARITY, so neither
    // entry may carry a defect of its own or the test would pass for the wrong
    // reason — distinct ids and distinct prices, both legal.
    const two = parseManifestGoods(
      manifestWith([
        VALID_UNLOCK,
        { ...VALID_UNLOCK, id: 'full-access-2', title: 'Full access 2', priceBuzz: 4_200 },
      ])
    );
    expect(two.errors).toHaveLength(1);
    expect(two.errors[0]).toContain('app_unlock');
    expect(parseManifestGoods(manifestWith([VALID_UNLOCK])).errors).toEqual([]);
  });

  it('counts the unlock arity per MANIFEST, not per adjacent ordinary good', () => {
    // One unlock alongside several ordinary goods is legal — the bound is on the
    // unlock kind alone, not on catalog size (that is BLOCK_GOOD_MAX_PER_MANIFEST).
    const mixed = parseManifestGoods(
      manifestWith([
        VALID_UNLOCK,
        { ...VALID_GOOD, id: 'item-a', priceBuzz: 700 },
        { ...VALID_GOOD, id: 'item-b', priceBuzz: 900 },
      ])
    );
    expect(mixed.errors).toEqual([]);
    expect(mixed.goods).toHaveLength(3);
  });

  it('REJECTS an app_unlock good with NO justification — the free→paid review trigger', () => {
    // 🔴 WHY THIS RULE EXISTS. An app unlock is designed NOT to require the
    // sensitive `goods:purchase:self` scope, so the sensitive-scope justification
    // gate cannot see it: without this, a v2 could flip a free app to paid with
    // nothing for a moderator to read.
    const { errors, goods } = parseManifestGoods(
      manifestWith([{ id: 'full-access', title: 'Full access', priceBuzz: 3_100, kind: 'app_unlock' }])
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('justification');
    expect(goods).toHaveLength(0);
  });

  it('REJECTS an app_unlock justification that is empty or whitespace-only', () => {
    // A present-but-blank string must not satisfy the gate — "a guard can be
    // SPELLED rather than structural"; the moderator needs words, not a key.
    for (const justification of ['', '   ', '\n\t ']) {
      const { errors } = parseManifestGoods(
        manifestWith([{ ...VALID_UNLOCK, justification }])
      );
      expect(errors, JSON.stringify(justification)).toHaveLength(1);
      expect(errors[0]).toContain('justification');
    }
  });

  it('REJECTS an over-long justification and ACCEPTS one at exactly the bound', () => {
    expect(
      parseManifestGoods(
        manifestWith([
          { ...VALID_UNLOCK, justification: 'x'.repeat(BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH + 1) },
        ])
      ).errors
    ).toHaveLength(1);
    expect(
      parseManifestGoods(
        manifestWith([
          { ...VALID_UNLOCK, justification: 'x'.repeat(BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH) },
        ])
      ).errors
    ).toEqual([]);
  });

  it('does NOT require a justification on an ORDINARY good, but accepts and trims one', () => {
    // The requirement is keyed on the KIND, not on the field existing. An ordinary
    // good without a justification stays valid — otherwise this change would
    // retroactively invalidate any future non-unlock catalog.
    expect(parseManifestGoods(manifestWith([VALID_GOOD])).errors).toEqual([]);
    const { goods, errors } = parseManifestGoods(
      manifestWith([{ ...VALID_GOOD, justification: '  because slots cost storage  ' }])
    );
    expect(errors).toEqual([]);
    expect(goods[0].justification).toBe('because slots cost storage');
  });

  it('makes an over-cap or unjustified unlock UNSELLABLE, not merely unapprovable', () => {
    // 🔴 THE SEAM. `findManifestGood` is what the purchase path resolves through,
    // and it returns null when the catalog has ANY error — so these bounds reach
    // the money path with no second copy of either rule. A manifest approved
    // before this shipped cannot keep selling on the old terms.
    const overCap = manifestWith([
      { ...VALID_UNLOCK, priceBuzz: BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ + 1 },
    ]);
    expect(findManifestGood(overCap, 'full-access')).toBeNull();
    const unjustified = manifestWith([
      { id: 'full-access', title: 'Full access', priceBuzz: 3_100, kind: 'app_unlock' },
    ]);
    expect(findManifestGood(unjustified, 'full-access')).toBeNull();
    // Positive control on the read: the SAME id IS resolvable once both rules pass,
    // so the nulls above are the rules firing and not a broken lookup.
    expect(findManifestGood(manifestWith([VALID_UNLOCK]), 'full-access')?.priceBuzz).toBe(3_100);
  });
});

describe('INERTNESS — the app_unlock rules change nothing for a manifest without one', () => {
  /**
   * 🔴 THE NO-OP PROOF, not an assertion of it. Every app approved to date declares
   * no `goods` at all, and none declares an `app_unlock` good, so this PR must be
   * observably inert for them. These cases pin the three shapes a live manifest can
   * have — and each is a BEHAVIOURAL check (the exact returned value, or the exact
   * error count), not a "does not throw".
   *
   * The risk being pinned is specific and real: the parser was RESTRUCTURED to read
   * `kind` before `priceBuzz` so the ceiling could depend on it, and the
   * justification branch was inserted into the same per-entry walk. Either could
   * have changed the result for a manifest that has nothing to do with unlocks.
   */
  it('a manifest with NO goods key short-circuits to the empty result', () => {
    // The exact value, so a mutant returning `{goods:[],errors:['…']}` dies.
    expect(parseManifestGoods({})).toEqual({ goods: [], errors: [] });
    expect(parseManifestGoods({ goods: undefined })).toEqual({ goods: [], errors: [] });
    expect(parseManifestGoods({ goods: null })).toEqual({ goods: [], errors: [] });
  });

  it('a manifest with an EMPTY goods array still parses clean', () => {
    expect(parseManifestGoods(manifestWith([]))).toEqual({ goods: [], errors: [] });
  });

  it("a kind:'good' catalog is accepted with its kind and price untouched", () => {
    // Explicit `kind: 'good'` — the value a dev may write out — must behave exactly
    // like the default, and must NOT pick up the unlock ceiling or need a
    // justification.
    const explicit = parseManifestGoods(manifestWith([{ ...VALID_GOOD, kind: 'good' }]));
    expect(explicit.errors).toEqual([]);
    expect(explicit.goods).toHaveLength(1);
    expect(explicit.goods[0].kind).toBe('good');
    expect(explicit.goods[0].priceBuzz).toBe(1300);
    // And no `justification` key is invented on a good that did not declare one.
    expect(explicit.goods[0].justification).toBeUndefined();
    expect('justification' in explicit.goods[0]).toBe(false);
  });

  it('an ordinary good priced ABOVE the unlock cap is still accepted', () => {
    // The single most likely way this PR could have broken a live catalog. 40,000 is
    // legal for an ordinary good and 8x the unlock cap.
    const { errors, goods } = parseManifestGoods(
      manifestWith([{ ...VALID_GOOD, priceBuzz: 40_000 }])
    );
    expect(errors).toEqual([]);
    expect(goods[0].priceBuzz).toBe(40_000);
  });

  it('a catalog with a PARSE ERROR reports the SAME single error it always did', () => {
    // Not merely "still invalid" — still invalid for the SAME ONE REASON. A second
    // error appearing here would mean the new branches fire on an ordinary good.
    const { errors, goods } = parseManifestGoods(
      manifestWith([{ ...VALID_GOOD, priceBuzz: BLOCK_GOOD_MAX_PRICE_BUZZ + 1 }])
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('priceBuzz');
    expect(errors[0]).not.toContain('justification');
    expect(errors[0]).not.toContain('app_unlock');
    expect(goods).toHaveLength(0);
  });

  it('the general per-manifest cap is unchanged for ordinary goods', () => {
    // BLOCK_APP_UNLOCK_MAX_PER_MANIFEST must not have narrowed the catalog size for
    // everyone — the two bounds are about different things.
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...VALID_GOOD, id: `good-${i}` }));
    expect(parseManifestGoods(manifestWith(make(BLOCK_GOOD_MAX_PER_MANIFEST))).errors).toEqual([]);
    expect(BLOCK_APP_UNLOCK_MAX_PER_MANIFEST).toBeLessThan(BLOCK_GOOD_MAX_PER_MANIFEST);
  });
});

describe('maxPriceBuzzForKind — the per-kind ceiling, in one place', () => {
  it('returns the unlock cap for app_unlock and the general cap for an ordinary good', () => {
    expect(maxPriceBuzzForKind('app_unlock')).toBe(BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ);
    expect(maxPriceBuzzForKind('good')).toBe(BLOCK_GOOD_MAX_PRICE_BUZZ);
  });

  it('covers EVERY declared kind, so a new kind cannot be added without a decision here', () => {
    // Enumerates BLOCK_GOOD_KINDS rather than naming the two we have: adding a
    // third kind makes this fail unless its ceiling is deliberately chosen.
    for (const kind of BLOCK_GOOD_KINDS) {
      const max = maxPriceBuzzForKind(kind);
      expect(Number.isSafeInteger(max), kind).toBe(true);
      expect(max, kind).toBeGreaterThanOrEqual(BLOCK_GOOD_MIN_PRICE_BUZZ);
      expect(max, kind).toBeLessThanOrEqual(BLOCK_GOOD_MAX_PRICE_BUZZ);
    }
  });

  it('the unlock cap is STRICTLY below the general cap and above the floor', () => {
    // The bound is only meaningful if it actually narrows something.
    expect(BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ).toBeLessThan(BLOCK_GOOD_MAX_PRICE_BUZZ);
    expect(BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ).toBeGreaterThan(BLOCK_GOOD_MIN_PRICE_BUZZ);
  });
});

describe('the tip-ceiling and Stripe-minimum agreement guard', () => {
  /**
   * The per-tip ceiling, read out of its own source file. `BLOCK_TIP_MAX_PER_TIP`
   * cannot simply be imported here: its module imports the redis client at module
   * scope, and this suite is deliberately a pure client-safe constants test.
   */
  function tipMaxPerTip(): number {
    const source = readTipSource(
      path.join(REPO_ROOT, 'src/server/utils/block-tip-rate-limit.ts'),
      'utf8'
    );
    const match = /export const BLOCK_TIP_MAX_PER_TIP\s*=\s*([0-9_]+)\s*;/.exec(source);
    // POSITIVE CONTROL ON THE READ. A renamed constant, a moved file or a
    // reformatted literal must fail HERE — loudly, naming the cause — rather than
    // returning NaN and letting the comparison below pass or fail by accident.
    expect(match, 'BLOCK_TIP_MAX_PER_TIP not found in block-tip-rate-limit.ts').not.toBeNull();
    const value = Number(match![1].replace(/_/g, ''));
    expect(Number.isSafeInteger(value), `parsed ${match![1]}`).toBe(true);
    return value;
  }

  it('the unlock cap EQUALS the per-tip ceiling today', () => {
    // 🔴 WHY THIS ASSERTION EXISTS AND WHY IT IS NOT AN ALIAS — same reasoning as
    // the cosmetic-shop guard below. The two are independent knobs that currently
    // agree, and "an app unlock may move no more Buzz in one click than a tip" is
    // the claim the constant's rationale rests on. Asserted against the sibling
    // constant, not a literal, so a tipping repricing fails HERE — where the
    // comment explaining the choice lives — instead of drifting silently.
    expect(BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ).toBe(tipMaxPerTip());
  });

  it('the unlock cap EQUALS the smallest Buzz top-up a viewer can actually buy', () => {
    // $5 at 1,000 Buzz = $1. If the minimum Stripe charge or the Buzz/dollar ratio
    // moves, the ceiling stops being "one top-up buys at most one unlock" and this
    // is where that is noticed. Derived from both constants rather than asserting
    // 5_000 twice, so neither can move without failing.
    expect(BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ).toBe(
      (buzzConstants.minStripeChargeAmount / 100) * buzzConstants.buzzDollarRatio
    );
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

  it('🔴 keeps the cosmetic shop’s FLOAT artefact at 90, where integer arithmetic would differ', () => {
    // 🔴 THIS PINS A KNOWN 1-BUZZ UNDERPAYMENT AND IS NOT A MISTAKE. `0.7` is
    // not representable in binary, so `90 * 0.7` is 62.99999999999999 and
    // flooring it gives the owner 62 where `Math.floor(7 * 90 / 10)` gives 63.
    // It happens on 1,166 of the 49,998 legal prices; 90 is the SMALLEST.
    //
    // 🔴 WHY IT IS NOT FIXED. The instruction for this rail was "the same cut as
    // cosmetic shop item sales", and `computeCreatorShopSplit` uses the
    // identical `Math.floor(price * 0.7)`. Switching goods to integer
    // arithmetic would pay an app owner 63 where a cosmetic creator is paid 62
    // on the same price — breaking the parity that IS the requirement, for a
    // rounding artefact worth one Buzz. The drift guard above pins 999, which
    // is one of the ~97.7% of prices where the two rules agree, so it cannot
    // see this at all; that is the gap this case fills.
    //
    // 🔴 IF YOU CHANGE THE ARITHMETIC, THIS TEST IS THE DECISION, not an
    // obstacle: update it in the same commit and move the cosmetic shop with
    // it, or record why the two products are now allowed to disagree.
    expect(computeBlockGoodSplit(90)).toEqual({ appOwnerShare: 62, platformShare: 28 });
    // The integer rule genuinely disagrees here — without this the case above
    // could be satisfied by arithmetic that never had an artefact to keep.
    expect(Math.floor((7 * 90) / 10)).toBe(63);
    // …and the cosmetic shop lands on the same 62, which is the parity being
    // preserved. Asserted against the sibling function, not a literal, so a
    // repricing on that side fails here instead of drifting silently.
    expect(computeBlockGoodSplit(90).appOwnerShare).toBe(computeCreatorShopSplit(90).creatorPool);
    expect(computeBlockGoodSplit(90).platformShare).toBe(computeCreatorShopSplit(90).platformCut);
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

  it('the schema declares `justification` as a bounded string matching the parser', () => {
    // The field must EXIST in the schema: `items.additionalProperties` is false, so
    // an undeclared `justification` would be rejected by every local validator
    // (the CLI and the SDK both Ajv-validate the vendored copy) while the server
    // required it — local green, submit red.
    const justification = goodsProperty().items.properties.justification;
    expect(justification).toBeDefined();
    expect(justification.type).toBe('string');
    expect(justification.maxLength).toBe(BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH);
  });

  it('`justification` is NOT in `required` — the parser keys it on kind, not presence', () => {
    // 🔴 The bound that CANNOT move into the schema. "Required when kind is
    // app_unlock" is a conditional the schema deliberately does not express (an
    // `if/then` on `kind` was judged more surface than the property is worth), so
    // the imperative parser is the only enforcement. Pinning its ABSENCE here is
    // what stops someone "tidying up" by marking it required and rejecting every
    // ordinary good that omits it.
    expect(goodsProperty().items.required).not.toContain('justification');
  });

  it('the outer priceBuzz bound stays the GENERAL cap, not the unlock cap', () => {
    // 🔴 DELIBERATE, AND THE REASON THE PARSER IS AUTHORITATIVE. The per-kind
    // ceiling is NOT expressed in the schema; narrowing `maximum` to the unlock cap
    // here would reject legal ordinary goods in every offline validator. If this
    // assertion ever fails, the schema has quietly taken over a rule it cannot
    // express correctly.
    expect(goodsProperty().items.properties.priceBuzz.maximum).toBe(BLOCK_GOOD_MAX_PRICE_BUZZ);
    expect(BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ).toBeLessThan(BLOCK_GOOD_MAX_PRICE_BUZZ);
  });

  it('the kind DESCRIPTION states the narrower unlock bounds, so the published docs do not lie', () => {
    // The schema is the published developer contract (served at
    // /schemas/app-block/v1.json and mirrored into the CLI + SDK). Since the
    // narrower rules are enforced only by the server, the description is the ONLY
    // place a developer can learn them before a submit fails. Asserted against the
    // CONSTANTS so a repricing cannot leave the prose behind.
    const description = goodsProperty().items.properties.kind.description ?? '';
    // 🔴 THE WHOLE PHRASE, NOT THE BARE NUMBER. A naked
    // `toContain(String(BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ))` SURVIVED a mutation that
    // rewrote the sentence to "at most 50000 Buzz" — because "50000" contains the
    // substring "5000". The digits of a wrong number can spell the right one, so the
    // assertion pins the surrounding words too, and both are built from the constant
    // rather than typed as literals.
    expect(description).toContain(`at most ${BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ} Buzz`);
    // …and must NOT state the GENERAL cap as the unlock bound, which is the exact
    // wrong-but-plausible sentence the surviving mutant produced.
    expect(description).not.toContain(`at most ${BLOCK_GOOD_MAX_PRICE_BUZZ} Buzz`);
    expect(description).toContain('justification');
    expect(description.toLowerCase()).toContain('one app_unlock');
  });

  it('the schema requires exactly the fields the parser requires', () => {
    expect([...goodsProperty().items.required].sort()).toEqual(['id', 'priceBuzz', 'title']);
    // `additionalProperties: false` is what keeps a typo'd key from being
    // silently accepted locally and then ignored by the server.
    expect(goodsProperty().items.additionalProperties).toBe(false);
  });
});
