import { describe, expect, it } from 'vitest';
import { otherApprovedListingDeclaresOffline } from '~/server/services/blocks/connect-offline-listing';

const DECLARES = { offline_access: 'syncs your images every night' };
const row = (r: {
  id: string;
  kind?: string;
  status?: string;
  revisionOfId?: string | null;
  connectScopeJustifications?: unknown;
}) => ({
  kind: 'offsite',
  status: 'approved',
  revisionOfId: null,
  connectScopeJustifications: DECLARES,
  ...r,
});

describe('otherApprovedListingDeclaresOffline — over one OAuth client’s listings', () => {
  it('another approved off-site listing that declares → true', () => {
    expect(
      otherApprovedListingDeclaresOffline(
        [row({ id: 'apl_this', connectScopeJustifications: null }), row({ id: 'apl_other' })],
        ['apl_this']
      )
    ).toBe(true);
  });

  it('an excluded listing’s own declaration does not count', () => {
    expect(
      otherApprovedListingDeclaresOffline(
        [row({ id: 'apl_this' }), row({ id: 'apl_parent' })],
        ['apl_this', 'apl_parent']
      )
    ).toBe(false);
  });

  it.each([
    ['pending', { status: 'pending' }],
    ['removed', { status: 'removed' }],
    ['draft', { status: 'draft' }],
    ['rejected', { status: 'rejected' }],
    ['a shadow revision', { revisionOfId: 'apl_live' }],
    ['on-site', { kind: 'onsite' }],
    ['no declaration', { connectScopeJustifications: { ModelsRead: 'browse models' } }],
    ['a blank declaration', { connectScopeJustifications: { offline_access: '  ' } }],
  ])('another listing that is %s → false', (_label, over) => {
    expect(
      otherApprovedListingDeclaresOffline([row({ id: 'apl_other', ...over })], ['apl_this'])
    ).toBe(false);
  });
});
