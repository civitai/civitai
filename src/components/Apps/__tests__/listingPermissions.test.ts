import { describe, expect, it } from 'vitest';
import {
  blockScopePermissions,
  connectScopePermissions,
  groupListingPermissions,
} from '~/components/Apps/listingPermissions';

/**
 * The store page's permission row model and its ONE grouping/ordering rule (blocking `unit`
 * project). The browser suite (`AppListingDetailBody.permissions.browser.test.tsx`) pins the
 * render; this pins the decision for both listing shapes.
 *
 * Fixtures are stored in an order the rule must CHANGE — plain scopes first, sensitive ones in
 * descending bit order — so "kept the stored order" and "sorted" are different outputs.
 * Expected ids are literals.
 */

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe('groupListingPermissions — on-site block scopes', () => {
  it('sensitive first, each group by OAuth bit, bit-less scopes last in stored order', () => {
    const { sensitive, other } = groupListingPermissions(
      blockScopePermissions([
        'collections:read:self', // no bit
        'apps:storage', // no bit
        'models:read:self', // ModelsRead (4)
        'social:tip:self', // SocialTip (1 << 20), sensitive
        'ai:write:budgeted', // AIServicesWrite (1 << 15), sensitive
      ])
    );
    expect(ids(sensitive)).toEqual(['ai:write:budgeted', 'social:tip:self']);
    expect(ids(other)).toEqual(['models:read:self', 'collections:read:self', 'apps:storage']);
  });

  it('plain-language titles, with the description and then the id as fallbacks', () => {
    const [known, unknown] = blockScopePermissions(['models:read:self', 'made:up:scope']);
    expect(known.title).toBe('See the model it sits on');
    expect(known.detail).toBeTruthy();
    // An unknown scope is never dropped: it falls through to its id.
    expect(unknown).toMatchObject({
      id: 'made:up:scope',
      title: 'made:up:scope',
      sensitive: false,
    });
  });
});

describe('groupListingPermissions — off-site connect scopes', () => {
  it('the same rule: sensitive first, each group by bit', () => {
    const { sensitive, other } = groupListingPermissions(
      connectScopePermissions(['CollectionsRead', 'ModelsRead', 'SocialTip', 'BuzzRead'])
    );
    expect(ids(sensitive)).toEqual(['BuzzRead', 'SocialTip']);
    expect(ids(other)).toEqual(['ModelsRead', 'CollectionsRead']);
    expect(sensitive[0].title).toBe('View buzz balance & history');
  });

  it('drops a key the TokenScope table does not know', () => {
    expect(ids(connectScopePermissions(['NotAScope', 'ModelsRead']))).toEqual(['ModelsRead']);
  });
});
