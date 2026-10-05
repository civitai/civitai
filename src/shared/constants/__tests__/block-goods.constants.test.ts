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
// The per-scope justification bound, imported through the client-safe re-export
// shim in this same directory (NOT reached for via the auth package directly).
import { SCOPE_JUSTIFICATION_MAX_LENGTH } from '~/shared/constants/token-scope.constants';

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
    // 🔴 THE MESSAGE MUST NAME THE UNLOCK CEILING, NOT THE GENERAL ONE. Asserting
    // only `toContain('priceBuzz')` let a mutant that reverted the interpolation
    // survive a fully green suite — and the consequence is not cosmetic: the JSON
    // Schema's `maximum` is deliberately still the general cap and the narrow rule
    // lives only in a prose description, so this string is the ONLY machine-readable
    // statement of the real limit. Reverted, a developer at 5001 was told to stay
    // "between 2 and 50000 Buzz" — the bound they had just satisfied.
    expect(over.errors[0]).toContain(`and ${BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ} Buzz`);
    expect(over.errors[0]).not.toContain(`and ${BLOCK_GOOD_MAX_PRICE_BUZZ} Buzz`);
    expect(over.errors[0]).toContain('app_unlock');
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
    // INVARIANT GUARD, not regression coverage: the merge-base had no arity rule at
    // all, so this case was green there too. It is here as the bound's CONTROL —
    // proof it does not over-fire — not as evidence the bound exists. One unlock
    // alongside several ordinary goods is legal; the bound is on the unlock kind
    // alone, not on catalog size (that is BLOCK_GOOD_MAX_PER_MANIFEST).
    const mixed = parseManifestGoods(
      manifestWith([
        VALID_UNLOCK,
        { ...VALID_GOOD, id: 'item-a', priceBuzz: 1700 },
        { ...VALID_GOOD, id: 'item-b', priceBuzz: 900 },
      ])
    );
    expect(mixed.errors).toEqual([]);
    expect(mixed.goods).toHaveLength(3);
  });

  it('counts the arity over ACCEPTED goods, so one bad sibling yields ONE error, not two', () => {
    // 🔴 PINS A DOCUMENTED DECISION THAT WAS OTHERWISE UNTESTED. Counting the RAW
    // entries instead survived a green suite, and its cost is a second, confusing
    // message about an entry that already has one.
    //
    // (a) Two unlocks, one over the unlock cap: ONLY the price error.
    const overCapSibling = parseManifestGoods(
      manifestWith([
        VALID_UNLOCK,
        {
          ...VALID_UNLOCK,
          id: 'full-access-2',
          priceBuzz: BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ + 1,
        },
      ])
    );
    expect(overCapSibling.errors).toHaveLength(1);
    expect(overCapSibling.errors[0]).toContain('priceBuzz');
    // The arity message would be errors[1] under a raw-count mutant, so assert over the
    // WHOLE set rather than errors[0] — a `not.toContain` on the first element alone is
    // satisfied in both worlds and carries no weight.
    expect(overCapSibling.errors.join(' | ')).not.toContain('at most');

    // (b) Two unlocks sharing an id: ONLY the duplicate error. The duplicate is
    // dropped BEFORE the count, so it never reaches the arity rule — which is also
    // the answer to "how do the arity and duplicate-id rules interact".
    const duplicateSibling = parseManifestGoods(manifestWith([VALID_UNLOCK, { ...VALID_UNLOCK }]));
    expect(duplicateSibling.errors).toHaveLength(1);
    expect(duplicateSibling.errors[0]).toContain('duplicates an earlier good id');
    expect(duplicateSibling.goods.filter((g) => g.kind === 'app_unlock')).toHaveLength(1);
  });

  it('REJECTS an app_unlock good with NO justification — the free→paid review trigger', () => {
    // 🔴 WHY THIS RULE EXISTS — and it is NOT "the scope gate cannot see an unlock".
    // It can, for a FREE app's first catalog: any non-empty `goods` requires
    // `goods:purchase:self`, that scope IS sensitive, and a sensitive scope demands a
    // justification. The gap is that the scope is declared ONCE and does not move
    // when a later version adds an unlock — so an app already selling ordinary items
    // can start charging for ADMISSION with its permission set unchanged, and nothing
    // on the review screen would mention it. Keying on the KIND is what sees that,
    // and it keeps working if the scope requirement for unlocks is ever relaxed.
    const { errors, goods } = parseManifestGoods(
      manifestWith([{ id: 'full-access', title: 'Full access', priceBuzz: 3_100, kind: 'app_unlock' }])
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('justification');
    expect(goods).toHaveLength(0);
  });

  it('REJECTS an app_unlock justification that is empty, whitespace-only, or NOT A STRING', () => {
    // A present-but-blank string must not satisfy the gate — "a guard can be
    // SPELLED rather than structural"; the moderator needs words, not a key.
    //
    // 🔴 THE NON-STRING CASES ARE NOT PADDING. `parseManifestGoods` documents itself
    // as total and never-throwing, and the review MODAL calls it on an arbitrary
    // stored manifest — so the `typeof justification !== 'string'` half of this guard
    // is the only thing between a `justification: 123` and a TypeError from
    // `(123).trim()` rendering inside a moderator's review screen. Dropping that half
    // was measured to survive a fully green suite without these cases.
    for (const justification of ['', '   ', '\n\t ', 123, null, {}, [], true]) {
      const { errors, goods } = parseManifestGoods(
        manifestWith([{ ...VALID_UNLOCK, justification }])
      );
      expect(errors, JSON.stringify(justification)).toHaveLength(1);
      expect(errors[0], JSON.stringify(justification)).toContain('justification');
      expect(goods, JSON.stringify(justification)).toHaveLength(0);
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

  it('measures the justification bound against the TRIMMED string, as the schema promises', () => {
    // 🔴 WITHOUT THIS THE `.trim()` IS UNTESTED — both fixtures above are bare
    // `'x'.repeat(N)`, for which trimming is a no-op, so dropping `.trim()` survived
    // a green suite. The published schema states in prose that "the server measures
    // the TRIMMED length, so this maxLength is never more permissive than the
    // server", and this is the only thing holding that claim up.
    const padded = `  ${'x'.repeat(BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH)}  `;
    // Raw length is OVER the bound; trimmed length is exactly ON it. Asserted, so a
    // wrong envelope cannot make this a near-bound test instead of an at-bound one.
    expect(padded.length).toBe(BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH + 4);
    expect(padded.trim().length).toBe(BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH);
    const { errors, goods } = parseManifestGoods(
      manifestWith([{ ...VALID_UNLOCK, justification: padded }])
    );
    expect(errors).toEqual([]);
    // Stored trimmed, so the padding never reaches the moderator's screen either.
    expect(goods[0].justification).toHaveLength(BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH);
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
    // and it returns null when the catalog has ANY error — so these bounds reach the
    // money path through ONE definition rather than a re-derivation. A manifest
    // approved before this shipped cannot keep selling on the old terms.
    //
    // ⚠️ `purchaseBlockGood` ALSO re-checks the price, deliberately, for the drift
    // case where the parser is not the gate — and it read the GENERAL ceiling until
    // this PR, so an `app_unlock` was bounded there at 10x its real cap. It now calls
    // `maxPriceBuzzForKind` too. Unreachable via HTTP today (this very seam refuses
    // first), which is exactly why it had to be fixed rather than left for the PR
    // that adds a second producer of a resolved good.
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

  it('returns a sane ceiling for every declared kind', () => {
    // 🔴 DELIBERATELY NOT TITLED "a new kind cannot be added without a decision" —
    // IT CANNOT BUY THAT, AND SAYING SO WOULD BE A DOCSTRING CLAIMING COVERAGE IT
    // DOES NOT PROVIDE. Measured: with `maxPriceBuzzForKind` written as a ternary
    // with a default, adding a third kind let it fall through to the general 50,000
    // ceiling and satisfied every assertion below — a new way to charge, admitted at
    // the loosest bound, with this test green. What actually buys the property is
    // DETERMINISTIC: `MAX_PRICE_BUZZ_BY_KIND` is a `Record<BlockGoodKind, number>`,
    // so a new kind fails TYPECHECK until its ceiling is written down. This case is
    // the sanity bound on the values that record holds, nothing more.
    for (const kind of BLOCK_GOOD_KINDS) {
      const max = maxPriceBuzzForKind(kind);
      expect(Number.isSafeInteger(max), kind).toBe(true);
      expect(max, kind).toBeGreaterThanOrEqual(BLOCK_GOOD_MIN_PRICE_BUZZ);
      expect(max, kind).toBeLessThanOrEqual(BLOCK_GOOD_MAX_PRICE_BUZZ);
    }
  });

  it('FAILS CLOSED on an unrecognised kind rather than returning undefined', () => {
    // 🔴 THE HAZARD THIS PINS, MEASURED: a bare `RECORD[kind]` returns `undefined`
    // for a key it does not hold, and `priceBuzz > undefined` is FALSE in JS — so the
    // purchase-time ceiling would have been silently DISABLED, not merely loosened.
    // That is strictly worse than the kind-blind check it replaced, which at least
    // bounded at 50,000.
    //
    // The cast is the point: it reproduces what a cast, a rehydrated JSON blob, or a
    // future caller supplying its own resolved good can do, none of which the type
    // system sees. Asserting a NUMBER (not just "not undefined") is what makes the
    // comparison downstream meaningful.
    const rogue = maxPriceBuzzForKind('bundle' as unknown as (typeof BLOCK_GOOD_KINDS)[number]);
    expect(typeof rogue).toBe('number');
    expect(Number.isSafeInteger(rogue)).toBe(true);
    // Strictest, so an unknown kind REFUSES rather than overcharges.
    expect(rogue).toBe(Math.min(...BLOCK_GOOD_KINDS.map((k) => maxPriceBuzzForKind(k))));
    // And the comparison the money path actually makes behaves as a guard.
    expect(rogue + 1 > rogue).toBe(true);
  });

  it('is reached THROUGH parseManifestGoods, not only when called directly', () => {
    // A helper only ever exercised by its own unit test is not demonstrably wired in.
    // Same price, same manifest, different kind — the only thing that can explain the
    // divergence is the per-kind lookup actually being consulted by the parser.
    const price = BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ + 1;
    expect(price).toBeLessThanOrEqual(maxPriceBuzzForKind('good'));
    expect(price).toBeGreaterThan(maxPriceBuzzForKind('app_unlock'));
    expect(parseManifestGoods(manifestWith([{ ...VALID_GOOD, priceBuzz: price }])).errors).toEqual(
      []
    );
    expect(
      parseManifestGoods(
        manifestWith([
          {
            id: 'full-access',
            title: 'Full access',
            priceBuzz: price,
            kind: 'app_unlock',
            justification: 'Covers the per-session GPU cost.',
          },
        ])
      ).errors
    ).toHaveLength(1);
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
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/server/utils/block-tip-rate-limit.ts'),
      'utf8'
    );
    // 🔴 ANCHORED TO A LINE START (`^` + `m`). Unanchored, the FIRST textual match
    // wins regardless of whether it is live code — measured: a leftover
    // `// legacy: export const BLOCK_TIP_MAX_PER_TIP = 5_000;` above a live `9_000`
    // made this guard report the two ceilings agreed while the real per-tip ceiling
    // had moved, i.e. it reported agreement at the exact moment of the drift it
    // exists to catch. A commented-out old value is an ordinary thing to leave
    // behind during a repricing.
    const match = /^export const BLOCK_TIP_MAX_PER_TIP\s*=\s*([0-9_]+)\s*;/m.exec(source);
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

  it('the good-justification length bound EQUALS the per-scope justification bound', () => {
    // 🔴 THIS FILE WRITES AN AGREEMENT GUARD FOR EVERY OTHER BY-POLICY DUPLICATE
    // (the tip ceiling above, the creator-shop share below) AND THIS ONE HAD NONE —
    // the one duplicate whose divergence nobody would ever notice. Unlike
    // `BLOCK_TIP_MAX_PER_TIP` it is trivially importable: a client-safe re-export
    // shim sits in this very directory, which retires the earlier claim that the
    // constant stayed local to "avoid an auth-package import". (Pedantically, going
    // through the shim IS an auth-package import — just a client-safe one; the point
    // is that nothing stood in the way of the guard.)
    expect(BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH).toBe(SCOPE_JUSTIFICATION_MAX_LENGTH);
    // ⚠️ THE NUMBER AGREES; THE RULE DOES NOT, and that is deliberate rather than an
    // oversight: the per-scope check measures the RAW string
    // (`block-manifest-validator.service.ts`) while this one measures the TRIMMED one.
    //
    // 🔴 An earlier version of this guard "asserted" that with two lines of arithmetic
    // about its own fixture (`502 > 500`, `500 === 500`) and invoked NEITHER validator
    // — a docstring wider than its body, the exact defect this PR renames another test
    // to avoid. So the claim is made against the PARSER instead: a padded string whose
    // RAW length exceeds the shared bound is ACCEPTED here, which is only true because
    // this side trims. The scope side's raw measurement is not this file's to pin.
    const padded = `  ${'x'.repeat(SCOPE_JUSTIFICATION_MAX_LENGTH)}  `;
    // AT the bound once trimmed, OVER it raw — asserted, so this stays an at-bound case
    // rather than drifting into a merely near-bound one.
    expect(padded.length).toBe(SCOPE_JUSTIFICATION_MAX_LENGTH + 4);
    expect(padded.trim().length).toBe(BLOCK_GOOD_JUSTIFICATION_MAX_LENGTH);
    expect(
      parseManifestGoods(
        manifestWith([
          {
            id: 'full-access',
            title: 'Full access',
            priceBuzz: 3_100,
            kind: 'app_unlock',
            justification: padded,
          },
        ])
      ).errors
    ).toEqual([]);
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
    // 🔴 `minLength` IS LOAD-BEARING AND WAS UNASSERTED. Without it the offline
    // validators (the CLI and the SDK both Ajv-validate the vendored copy) accept
    // `justification: ""`, which the server rejects — the exact local-green /
    // submit-red asymmetry the comment above says this block exists to prevent,
    // for the field right next to the one it was checking.
    expect(justification.minLength).toBe(1);
  });

  it('`justification` is NOT in `required` — the parser keys it on kind, not presence', () => {
    // INVARIANT GUARD, not regression coverage: this was already true of the
    // merge-base schema (the property did not exist, so it was not required). It
    // pins the ABSENCE so a later "tidy-up" cannot mark it required and thereby
    // reject every ordinary good that omits it.
    // 🔴 The bound that CANNOT move into the schema. "Required when kind is
    // app_unlock" is a conditional the schema deliberately does not express (an
    // `if/then` on `kind` was judged more surface than the property is worth), so
    // the imperative parser is the only enforcement. Pinning its ABSENCE here is
    // what stops someone "tidying up" by marking it required and rejecting every
    // ordinary good that omits it.
    expect(goodsProperty().items.required).not.toContain('justification');
  });

  it('the outer priceBuzz bound stays the GENERAL cap, not the unlock cap', () => {
    // INVARIANT GUARD, not regression coverage — already true at the merge-base.
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
    // 🔴 THE CLAIM, NOT THE WORD. A bare `toContain('justification')` is walkable by
    // rewording: "a justification is OPTIONAL for an app unlock" contains the word
    // and would have passed while stating the opposite of the rule. Pin the sentence.
    expect(description).toContain('MUST carry a `justification`');
    // 🔴 BUILT FROM THE CONSTANT, not the literal "ONE". The price phrase two lines up
    // is derived; this one was not, so moving BLOCK_APP_UNLOCK_MAX_PER_MANIFEST to 2
    // would leave the published prose false with this guard green — the exact asymmetry
    // the price assertion exists to prevent.
    expect(BLOCK_APP_UNLOCK_MAX_PER_MANIFEST).toBe(1);
    expect(description).toContain(
      `at most ${BLOCK_APP_UNLOCK_MAX_PER_MANIFEST === 1 ? 'ONE' : BLOCK_APP_UNLOCK_MAX_PER_MANIFEST} app_unlock good`
    );
  });

  it('the priceBuzz DESCRIPTION warns that its maximum is not the per-kind limit', () => {
    // 🔴 THE FIELD BEING CONSTRAINED MUST STATE ITS OWN CONSTRAINT. `priceBuzz.maximum`
    // is deliberately left at the general 50,000, and the narrow unlock ceiling lived
    // ONLY in the `kind` description — so a developer reading the field they are
    // actually setting saw "minimum 2, maximum 50000" and nothing else. The cross
    // reference existed one way (`kind` mentions priceBuzz) and not the other, which is
    // how a schema stays technically true and still misleads.
    const price = goodsProperty().items.properties.priceBuzz.description ?? '';
    expect(price).toContain(`capped at ${BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ} Buzz`);
    expect(price).toContain('app_unlock');
    // And it must not imply its own maximum is the binding limit for every kind.
    expect(price).toMatch(/NOT THE LIMIT FOR YOUR GOOD|not the limit for your good/);
  });

  it('the justification DESCRIPTION does not deny the scope requirement', () => {
    // 🔴 THIS FIELD'S PROSE WAS UNPINNED, AND IT IS WHERE A FALSE PUBLISHED CLAIM
    // SURVIVED THE FEATURE COMMIT PLUS TWO FIX ROUNDS. It said an app unlock "does not
    // require the sensitive `goods:purchase:self` scope" — contradicting this schema's
    // own `goods` description — and nothing could fail. The sibling `kind` prose has a
    // drift assertion precisely because the published docs must not lie; this field had
    // none, which is the whole reason the error lasted.
    const justification = goodsProperty().items.properties.justification.description ?? '';
    expect(justification).not.toMatch(/does not require .*goods:purchase:self/);
    expect(justification).toContain('goods:purchase:self');
    expect(justification).toContain('REQUIRED when kind is "app_unlock"');
  });

  it('the kind DESCRIPTION does not claim declaring app_unlock is free', () => {
    // 🔴 ALSO FALSIFIED BY THIS PR AND MISSED FOR THREE ROUNDS. The description used to
    // say "Declaring it now buys nothing, so leave it unset" — true before these bounds
    // existed, and afterwards both wrong AND read as advice to avoid the review trigger,
    // sitting two clauses from the sentence enumerating the three rules it denies.
    const description = goodsProperty().items.properties.kind.description ?? '';
    expect(description).not.toContain('buys nothing');
    expect(description).not.toMatch(/leave it unset unless/);
  });

  it('the schema requires exactly the fields the parser requires', () => {
    expect([...goodsProperty().items.required].sort()).toEqual(['id', 'priceBuzz', 'title']);
    // `additionalProperties: false` is what keeps a typo'd key from being
    // silently accepted locally and then ignored by the server.
    expect(goodsProperty().items.additionalProperties).toBe(false);
  });
});
