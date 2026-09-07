import { describe, expect, it } from 'vitest';

import {
  BLOCK_INIT_FRAGMENT_ALLOWLIST,
  BLOCK_INIT_FRAGMENT_DENYLIST,
  blockInitFragmentEnabled,
  blockInitFragmentEnabledWith,
  type BlockHostSurface,
} from '../blockInitFragmentGate';

const ALL_SURFACES: BlockHostSurface[] = ['model-slot', 'page-run', 'dev-tunnel', 'review-preview'];

/**
 * A NON-EMPTY allowlist, used to make the ordering guarantees observable.
 *
 * 🔴 Testing the production binding alone would be vacuous. Its allowlist is
 * empty, so every call returns `false`, and `false` cannot distinguish "the dev
 * tunnel was refused first" from "nothing was allowlisted" — a guard only ever
 * seen returning false is an untested guard. Driving the injectable form with
 * entries present is what makes each branch REACHABLE.
 */
const TEST_ALLOW: ReadonlySet<string> = new Set([
  'apb_allowed',
  'allowed-slug',
  'playable-collections',
]);
const TEST_DENY: ReadonlySet<string> = new Set(['playable-collections']);

describe('blockInitFragmentEnabledWith — positive control', () => {
  it('🔴 CAN return true — otherwise every other assertion here is vacuous', () => {
    // If this ever fails, the predicate has been reduced to a constant `false`
    // and the rest of this file proves nothing.
    expect(
      blockInitFragmentEnabledWith(
        { surface: 'page-run', blockId: 'apb_allowed' },
        TEST_ALLOW,
        TEST_DENY
      )
    ).toBe(true);
    expect(
      blockInitFragmentEnabledWith(
        { surface: 'model-slot', slug: 'allowed-slug' },
        TEST_ALLOW,
        TEST_DENY
      )
    ).toBe(true);
  });
});

describe('blockInitFragmentEnabledWith — the dev tunnel is refused BY CONSTRUCTION', () => {
  it('🔴 refuses dev-tunnel even for a block that IS allowlisted', () => {
    // The gap an allowlist cannot close. `resolveDevPageBlockForAuthor` applies
    // no status filter, so the tunnel mounts arbitrary UNPUBLISHED code under
    // the SAME blockId the author will eventually publish. Were the surface not
    // an independent axis checked FIRST, allowlisting a block for production
    // would silently enable it on the author's draft too.
    //
    // The sibling assertion is what gives this teeth: the identical id on
    // another surface returns TRUE, so the only thing producing `false` here is
    // the surface check.
    expect(
      blockInitFragmentEnabledWith(
        { surface: 'dev-tunnel', blockId: 'apb_allowed' },
        TEST_ALLOW,
        TEST_DENY
      )
    ).toBe(false);
    expect(
      blockInitFragmentEnabledWith(
        { surface: 'page-run', blockId: 'apb_allowed' },
        TEST_ALLOW,
        TEST_DENY
      )
    ).toBe(true);
  });

  it('refuses dev-tunnel for every id shape, allowlisted or not', () => {
    for (const args of [
      { blockId: 'apb_allowed' },
      { slug: 'allowed-slug' },
      { blockId: 'apb_allowed', slug: 'allowed-slug' },
      { blockId: 'apb_unknown' },
      {},
    ]) {
      expect(
        blockInitFragmentEnabledWith({ surface: 'dev-tunnel', ...args }, TEST_ALLOW, TEST_DENY)
      ).toBe(false);
    }
  });
});

describe('blockInitFragmentEnabledWith — review-preview is refused too', () => {
  it('🔴 refuses review-preview even for a block that IS allowlisted', () => {
    // Same argument as the dev tunnel, and it transfers wholesale: the review
    // surface mints `page_<pubreq_…>` for a PENDING, UN-APPROVED submission, so
    // allowlisting a PUBLISHED app would enable the fragment on a moderator's
    // preview of that app's next unreviewed code. The sibling assertion is what
    // gives this teeth — the same id on page-run returns TRUE.
    expect(
      blockInitFragmentEnabledWith(
        { surface: 'review-preview', blockId: 'apb_allowed' },
        TEST_ALLOW,
        TEST_DENY
      )
    ).toBe(false);
    expect(
      blockInitFragmentEnabledWith(
        { surface: 'page-run', blockId: 'apb_allowed' },
        TEST_ALLOW,
        TEST_DENY
      )
    ).toBe(true);
  });

  it('leaves exactly two eligible surfaces: model-slot and page-run', () => {
    const eligible = ALL_SURFACES.filter((surface) =>
      blockInitFragmentEnabledWith({ surface, blockId: 'apb_allowed' }, TEST_ALLOW, TEST_DENY)
    );
    expect(eligible).toEqual(['model-slot', 'page-run']);
  });
});

describe('blockInitFragmentEnabledWith — the denylist beats the allowlist', () => {
  it('🔴 refuses a block present in BOTH lists', () => {
    // `playable-collections` is deliberately in TEST_ALLOW as well as
    // TEST_DENY. If the order were flipped, this would return true.
    expect(TEST_ALLOW.has('playable-collections')).toBe(true);
    expect(
      blockInitFragmentEnabledWith(
        { surface: 'page-run', slug: 'playable-collections' },
        TEST_ALLOW,
        TEST_DENY
      )
    ).toBe(false);
    expect(
      blockInitFragmentEnabledWith(
        { surface: 'model-slot', blockId: 'playable-collections' },
        TEST_ALLOW,
        TEST_DENY
      )
    ).toBe(false);
  });

  it('refuses a denylisted block on every surface', () => {
    for (const surface of ALL_SURFACES) {
      expect(
        blockInitFragmentEnabledWith(
          { surface, slug: 'playable-collections' },
          TEST_ALLOW,
          TEST_DENY
        )
      ).toBe(false);
    }
  });
});

describe('blockInitFragmentEnabledWith — opt-in only', () => {
  it('refuses a block that is in neither list', () => {
    for (const surface of ALL_SURFACES) {
      expect(
        blockInitFragmentEnabledWith(
          { surface, blockId: 'apb_stranger', slug: 'stranger' },
          TEST_ALLOW,
          TEST_DENY
        )
      ).toBe(false);
    }
  });

  it('refuses when neither a blockId nor a slug is known', () => {
    for (const surface of ALL_SURFACES) {
      expect(blockInitFragmentEnabledWith({ surface }, TEST_ALLOW, TEST_DENY)).toBe(false);
      expect(
        blockInitFragmentEnabledWith({ surface, blockId: null, slug: null }, TEST_ALLOW, TEST_DENY)
      ).toBe(false);
      // Empty strings must not match an empty-string allowlist entry either.
      expect(
        blockInitFragmentEnabledWith({ surface, blockId: '', slug: '' }, TEST_ALLOW, TEST_DENY)
      ).toBe(false);
    }
  });
});

describe('blockInitFragmentEnabled — the PRODUCTION allowlist', () => {
  it('🔴 contains EXACTLY the blocks opted in — pinned as a whole set', () => {
    // Bind against the REAL exported constant, not the injectable `TEST_ALLOW`.
    // Every assertion above drives `blockInitFragmentEnabledWith` with a
    // synthetic allowlist, which BY CONSTRUCTION cannot observe a change to the
    // production one — so without this test the shipped allowlist is unpinned
    // and could be widened silently.
    //
    // Pinned as a sorted array rather than `.has(...)` + `.size`: an exact
    // whole-set comparison fails on an ADDITION as well as a removal, and names
    // the offending entry in its own diff.
    expect([...BLOCK_INIT_FRAGMENT_ALLOWLIST].sort()).toEqual([
      'app-requests',
      'custom-generators',
      'model-benchmarking',
      'sensei',
    ]);
  });

  // 🔴 EACH NEW BLOCK IS ASSERTED ON ITS OWN, not covered by the `app-requests`
  // case below. Three entries went in together, and one shared assertion would
  // pass with any single member present — which is how a batch addition loses a
  // member silently. Both keys and each key alone, for the same reason the
  // `app-requests` case gives: a regression dropping one lookup branch still
  // passes if only the combined shape is tested.
  it.each(['custom-generators', 'model-benchmarking', 'sensei'])(
    '🔴 enables the fast path for %s on page-run, by either key',
    (id) => {
      expect(blockInitFragmentEnabled({ surface: 'page-run', slug: id, blockId: id })).toBe(true);
      expect(blockInitFragmentEnabled({ surface: 'page-run', slug: id })).toBe(true);
      expect(blockInitFragmentEnabled({ surface: 'page-run', blockId: id })).toBe(true);
    }
  );

  // The surface check must hold for the new entries too: allowlisting a PUBLISHED
  // app must never reach a moderator's preview of its next UNREVIEWED submission,
  // nor the author's dev tunnel. Paired with the page-run assertion above, which is
  // what stops this being vacuous — the SAME id returns true on an eligible
  // surface, so only the surface check can be producing false here.
  it.each(['custom-generators', 'model-benchmarking', 'sensei'])(
    '🔴 does NOT leak onto dev-tunnel or review-preview for %s',
    (id) => {
      for (const surface of ['dev-tunnel', 'review-preview'] as const) {
        expect(blockInitFragmentEnabled({ surface, slug: id, blockId: id })).toBe(false);
      }
    }
  );

  // 🔴 The DENYLIST must still beat the widened allowlist. `playable-collections`
  // shipped the same boot skeleton as the three above, in the same batch, and is
  // the one block of that set which reads `location.hash` for its own routing — so
  // it is deliberately NOT allowlisted.
  //
  // 🔴 THIS TEST WAS VACUOUS AS FIRST WRITTEN and the rewrite is the point. It
  // asserted `blockInitFragmentEnabled({slug:'playable-collections'}) === false`,
  // which passes for the WRONG REASON: that block is refused because it is not in
  // the allowlist, not because the denylist works. Rewiring the production wrapper
  // to pass an EMPTY denylist left it green — a guard reading as protection while
  // providing none.
  //
  // What it pins now is precedence against the REAL denylist: feed a synthetic
  // allowlist that DOES contain the block, alongside the real denylist, so the only
  // thing that can produce `false` is the denylist check winning.
  it('🔴 the REAL denylist beats an allowlist that contains the same block', () => {
    expect(BLOCK_INIT_FRAGMENT_ALLOWLIST.has('playable-collections')).toBe(false);

    const allowedAnyway = new Set([...BLOCK_INIT_FRAGMENT_ALLOWLIST, 'playable-collections']);

    // 🔴 EACH KEY ALONE, not just the combined shape — the same rule the `it.each`
    // above states, which the first version of THIS test broke by passing `slug`
    // and `blockId` together. Measured: with both keys supplied, deleting EITHER
    // denylist branch on its own left this test green, because the surviving branch
    // still matched. Driving each key alone is what makes a single deleted branch
    // fail here rather than only in the pre-existing per-key tests.
    for (const args of [
      { surface: 'page-run', slug: 'playable-collections' },
      { surface: 'page-run', blockId: 'playable-collections' },
      { surface: 'page-run', slug: 'playable-collections', blockId: 'playable-collections' },
    ] as const) {
      // Positive control: with the denylist EMPTY the same call returns true, so a
      // false below is the denylist winning and not the surface or a missing entry.
      expect(blockInitFragmentEnabledWith(args, allowedAnyway, new Set<string>())).toBe(true);
      expect(
        blockInitFragmentEnabledWith(args, allowedAnyway, BLOCK_INIT_FRAGMENT_DENYLIST)
      ).toBe(false);
    }
  });

  it('🔴 enables the fast path for app-requests on page-run', () => {
    // `app-requests` declares `"blockId": "app-requests"` and a `page` with no
    // slots, and on page-run `slug === blockId` — so the single allowlist string
    // matches whichever key the host passes. Assert BOTH keys and each alone,
    // because a regression that dropped one lookup branch would still pass if
    // only the combined shape were tested.
    expect(
      blockInitFragmentEnabled({
        surface: 'page-run',
        slug: 'app-requests',
        blockId: 'app-requests',
      })
    ).toBe(true);
    expect(blockInitFragmentEnabled({ surface: 'page-run', slug: 'app-requests' })).toBe(true);
    expect(blockInitFragmentEnabled({ surface: 'page-run', blockId: 'app-requests' })).toBe(true);
  });

  it('🔴 does NOT leak onto dev-tunnel or review-preview for that same block', () => {
    // THE POINT OF THIS TEST. Allowlisting a PUBLISHED app must not enable the
    // fragment on a moderator's preview of that same app's next UNREVIEWED
    // submission, nor on the author's dev tunnel — both mount unreviewed code
    // under an identity the allowlist cannot distinguish from the reviewed one.
    //
    // 🔴 This assertion was VACUOUS before `app-requests` was allowlisted: with
    // an empty allowlist every surface returned false anyway, so it could not
    // distinguish "the surface was refused first" from "nothing was listed".
    // The sibling page-run assertion is what gives it teeth — the SAME id on an
    // eligible surface returns TRUE, so the only thing producing `false` here
    // is the surface check.
    for (const surface of ['dev-tunnel', 'review-preview'] as const) {
      expect(
        blockInitFragmentEnabled({
          surface,
          slug: 'app-requests',
          blockId: 'app-requests',
        })
      ).toBe(false);
    }
    expect(
      blockInitFragmentEnabled({
        surface: 'page-run',
        slug: 'app-requests',
        blockId: 'app-requests',
      })
    ).toBe(true);
  });

  it('refuses a block that is on neither list, on every surface', () => {
    for (const surface of ALL_SURFACES) {
      expect(blockInitFragmentEnabled({ surface, blockId: 'anything', slug: 'anything' })).toBe(
        false
      );
    }
  });

  it('🔴 the PRODUCTION binding passes allow/deny in the RIGHT ORDER', () => {
    // The gap the injectable form leaves, and one the COMPILER CANNOT CATCH:
    // `blockInitFragmentEnabledWith(args, allowlist, denylist)` takes two
    // arguments of the SAME type, so swapping them type-checks cleanly. An
    // audit swapped them at the binding and ALL NINE of the tests above stayed
    // green, because they drive the injectable form directly — while
    // `blockInitFragmentEnabled({surface:'page-run', slug:'playable-collections'})`
    // started returning TRUE. The one block named as must-never-receive would
    // have received it.
    //
    // Neither a set-contents pin nor `DENYLIST.has(...)` nor a lookup of an
    // unknown id can see that swap: with the lists exchanged, the real
    // allowlist is consulted as the denylist and vice versa, so a DENYLISTED
    // slug is "allowed". Only asserting a denylisted id through the production
    // binding distinguishes the two wirings.
    expect(blockInitFragmentEnabled({ surface: 'page-run', slug: 'playable-collections' })).toBe(
      false
    );
    expect(
      blockInitFragmentEnabled({ surface: 'model-slot', blockId: 'playable-collections' })
    ).toBe(false);
  });

  it('🔴 keeps playable-collections false on EVERY surface — denylist beats the allowlist', () => {
    // Now that the real allowlist is non-empty, the denylist is doing load-
    // bearing work through the production binding rather than being masked by
    // an allowlist that refused everything anyway.
    for (const surface of ALL_SURFACES) {
      expect(
        blockInitFragmentEnabled({
          surface,
          slug: 'playable-collections',
          blockId: 'playable-collections',
        })
      ).toBe(false);
    }
  });

  it('pins playable-collections in the real denylist', () => {
    // It reads `location.hash` on first load and fails closed against our
    // fragment only BY LUCK — it looks for a `c` key we do not carry. Pinning
    // the entry means widening the allowlist later cannot silently re-enable it.
    expect(BLOCK_INIT_FRAGMENT_DENYLIST.has('playable-collections')).toBe(true);
  });
});
