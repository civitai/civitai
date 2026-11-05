import { describe, expect, it } from 'vitest';
import {
  blockScopeGroupLabels,
  blockScopeGroups,
  blockScopePermissions,
  connectScopePermissions,
  groupListingPermissions,
} from '~/components/Apps/listingPermissions';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';
import { isSensitiveBlockScope } from '~/shared/constants/block-scope.constants';

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

describe('blockScopeGroups — the groups every block-scope renderer draws', () => {
  it('puts every described scope in exactly one group, sensitive or "Other"', () => {
    const all = Object.keys(SCOPE_DESCRIPTIONS);
    expect(all.length, 'SCOPE_DESCRIPTIONS is empty — this checks nothing').toBeGreaterThan(5);
    for (const scope of all) {
      const groups = blockScopeGroups([scope]);
      expect(groups, scope).toHaveLength(1);
      expect(groups[0].scopes, scope).toEqual([scope]);
      expect(groups[0].key, scope).toBe(isSensitiveBlockScope(scope) ? 'sensitive' : 'other');
    }
    // All at once: the groups partition the input, nothing dropped or duplicated.
    const flat = blockScopeGroups(all).flatMap((g) => g.scopes);
    expect([...flat].sort()).toEqual([...all].sort());
  });

  it('an unknown scope lands in "Other", after the known ones', () => {
    expect(blockScopeGroups(['zz:not-a-real:scope', 'models:read:self'])).toEqual([
      {
        key: 'other',
        label: 'Other permissions',
        scopes: ['models:read:self', 'zz:not-a-real:scope'],
      },
    ]);
  });
});

describe('blockScopeGroupLabels — the ordered group labels for a set of scopes', () => {
  it('sensitive first, only the groups that have a scope', () => {
    expect(blockScopeGroupLabels(['models:read:self', 'ai:write:budgeted'])).toEqual([
      'Sensitive permissions',
      'Other permissions',
    ]);
    expect(blockScopeGroupLabels(['models:read:self', 'zz:not-a-real:scope'])).toEqual([
      'Other permissions',
    ]);
    expect(blockScopeGroupLabels(['social:tip:self'])).toEqual(['Sensitive permissions']);
    expect(blockScopeGroupLabels([])).toEqual([]);
  });
});
