import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { packDisplayMeta } from '../creator-shop.data';

/**
 * `packDisplayMeta` decides which parts of a shop item's meta the storefront
 * cards AND the pack detail endpoint publish — four call sites, one of them
 * reached by a public procedure.
 *
 * So a field added here for a card is a field added to that response too. The
 * listing below is the place that trade gets made deliberately: adding a key
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
  // it. This reads the keys out of the function itself, where a field added for
  // a storefront card cannot hide.
  it('names those three keys in its source and no others', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/server/services/creator-shop.data.ts'),
      'utf-8'
    );
    const start = source.indexOf('export const packDisplayMeta');
    const body = source.slice(start, source.indexOf('});', start));
    expect(start, 'packDisplayMeta moved — point this test at it again').toBeGreaterThan(-1);
    expect([...body.matchAll(/\{ (\w+):/g)].map((m) => m[1]).sort()).toEqual([
      'coverTiles',
      'coverUrl',
      'packMemberCount',
    ]);
  });
});
