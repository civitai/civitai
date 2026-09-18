import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { packDisplayMeta } from '../creator-shop.data';

/**
 * `packDisplayMeta` decides which parts of a shop item's meta the storefront
 * cards and the pack detail endpoint publish. All four of its call sites are
 * reached by a public procedure — `getShop`, `getCommunityCosmetics` and
 * `getPack`.
 *
 * So a field added here for one card is a field added to all of them. The
 * listing below is the place that trade gets made deliberately: adding a field
 * means editing this test, which is the only thing that says so out loud.
 */
describe('packDisplayMeta publishes exactly the pack card fields', () => {
  it('returns those three keys and nothing else from a full meta', () => {
    const published = packDisplayMeta({
      purchases: 1,
      coverUrl: 'cover.png',
      coverTiles: ['a.png'],
      packMemberCount: 2,
      acceptsBlueBuzz: true,
      creatorId: 5,
      submissionTxId: 'tx',
      submissionFee: 10,
      lastApprovedAmount: 20,
      paidToUserIds: [5],
      imageHash: 'hash',
      sellableByOthers: true,
      sellerShare: 30,
      rightsAffirmation: { userId: 5, affirmedAt: 'then', version: 1, statement: 'mine' },
      takedown: { reason: 'why', moderatorId: 6, at: 'then' },
      history: [{ at: 'then', userId: 6, kind: 'reviewed', action: 'reject', note: 'no' }],
    });
    expect(Object.keys(published).sort()).toEqual(['coverTiles', 'coverUrl', 'packMemberCount']);
  });

  it('omits a field the item does not have rather than publishing it undefined', () => {
    expect(packDisplayMeta({ purchases: 0 })).toEqual({});
    expect(packDisplayMeta(null)).toEqual({});
    // An empty tile list is not cover art; publishing the key would have a card
    // render an empty tile strip instead of falling back.
    expect(packDisplayMeta({ purchases: 0, coverTiles: [] })).toEqual({});
  });

  // The behavioural listing above can only see keys its fixture sets, so a NEW
  // conditional field — the shape every field here has — would be invisible to
  // it. This reads the fields out of the function itself, where one added for a
  // storefront card cannot hide.
  //
  // The count is the load-bearing half. A key regex has to guess how the
  // property was written, and `{ coverUrl }` shorthand carries no colon at all;
  // counting the conditional spreads fires however the field is spelled, and the
  // names then say WHICH three. If you convert this arrow to a block body the
  // slice terminator changes and the whole fence needs rewriting — which is the
  // moment to ask whether the new field should be public.
  it('names those three fields in its source and no others', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/server/services/creator-shop.data.ts'),
      'utf-8'
    );
    // Anchored through the `=` so a later `packDisplayMetaV2` declared above
    // cannot capture this and leave the fence guarding the wrong function.
    const start = source.indexOf('export const packDisplayMeta = ');
    expect(start, 'packDisplayMeta moved — point this test at it again').toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('});', start));
    expect(
      body.split('...(').length - 1,
      'a conditional field was added to or removed from the shared whitelist'
    ).toBe(3);
    expect([...body.matchAll(/\{\s*(\w+)\s*[:}]/g)].map((m) => m[1]).sort()).toEqual([
      'coverTiles',
      'coverUrl',
      'packMemberCount',
    ]);
  });
});
