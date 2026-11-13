import { describe, expect, it } from 'vitest';
import {
  IRREVOCABLE_PERMISSION_NOTE,
  blockScopePermissions,
} from '~/components/Apps/listingPermissions';
import {
  CONSENT_EXEMPT_SCOPES,
  isConsentExemptScope,
} from '~/shared/constants/block-scope.constants';
import {
  consentExemptScopeList,
  consentGatedScopes,
  partitionByConsent,
} from '~/server/services/blocks/scope-grant.service';

// The set decides what a token carries without a grant, so its members are pinned by name: adding
// or dropping one is a decision someone has to make on purpose.
const EXEMPT = [
  'apps:storage',
  'apps:storage:read',
  'apps:storage:shared:read',
  'apps:storage:shared:write',
  'apps:storage:write',
  'apps:store:items:write',
  'collections:read:self',
  'collections:write:self',
  'goods:read:self',
  'models:read:self',
];

describe('consent-exempt scopes', () => {
  it('are exactly the ten the mint signs without a grant', () => {
    expect([...CONSENT_EXEMPT_SCOPES].sort()).toEqual(EXEMPT);
    expect(consentExemptScopeList()).toEqual(EXEMPT);
  });

  it('are the same set the mint and the revoke refusal read', () => {
    for (const scope of EXEMPT) {
      expect(isConsentExemptScope(scope)).toBe(true);
      expect(partitionByConsent([scope], new Set()).signable).toEqual([scope]);
      expect(consentGatedScopes([scope])).toEqual([]);
    }
    expect(partitionByConsent(['posts:write:self'], new Set()).missing).toEqual([
      'posts:write:self',
    ]);
  });

  it('say so on every permission row before Allow, and only on those', () => {
    for (const row of blockScopePermissions(EXEMPT)) {
      expect(row.detail, row.id).toContain(IRREVOCABLE_PERMISSION_NOTE);
    }
    for (const row of blockScopePermissions(['ai:write:budgeted', 'posts:write:self'])) {
      expect(row.detail ?? '', row.id).not.toContain(IRREVOCABLE_PERMISSION_NOTE);
    }
  });

  it('are not told twice where the row already says it cannot be withdrawn', () => {
    for (const row of blockScopePermissions(EXEMPT, { noteIrrevocable: false })) {
      expect(row.detail ?? '', row.id).not.toContain(IRREVOCABLE_PERMISSION_NOTE);
    }
  });

  it('keep the sentence the scope already carried, ahead of the note', () => {
    const [row] = blockScopePermissions(['apps:store:items:write']);
    expect(row.detail?.startsWith('List items you made in this app')).toBe(true);
    expect(row.detail?.endsWith(IRREVOCABLE_PERMISSION_NOTE)).toBe(true);
  });
});
