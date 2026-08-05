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

describe('blockInitFragmentEnabled — the PRODUCTION binding is OFF', () => {
  it('🔴 ships with an EMPTY allowlist, so the fast path is inert everywhere', () => {
    // A live-block enumeration on 2026-08-05 found that NO deployed block can
    // decode the fragment (`civitai-block=v1` x0 across 20 bundles) because the
    // SDK half is merged but unpublished. Shipping it enabled would be pure
    // risk for zero benefit.
    expect(BLOCK_INIT_FRAGMENT_ALLOWLIST.size).toBe(0);
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
    // Neither `ALLOWLIST.size === 0` nor `DENYLIST.has(...)` nor a lookup of an
    // unknown id can see that swap: with the lists exchanged, the (empty)
    // allowlist becomes the denylist and the denylist becomes the allowlist, so
    // a denylisted slug is "allowed". Only asserting a DENYLISTED id through the
    // production binding distinguishes the two wirings.
    expect(blockInitFragmentEnabled({ surface: 'page-run', slug: 'playable-collections' })).toBe(
      false
    );
    expect(
      blockInitFragmentEnabled({ surface: 'model-slot', blockId: 'playable-collections' })
    ).toBe(false);
  });

  it('pins playable-collections in the real denylist', () => {
    // It reads `location.hash` on first load and fails closed against our
    // fragment only BY LUCK — it looks for a `c` key we do not carry. Pinning
    // the entry means widening the allowlist later cannot silently re-enable it.
    expect(BLOCK_INIT_FRAGMENT_DENYLIST.has('playable-collections')).toBe(true);
  });
});
