import { describe, expect, it } from 'vitest';
import {
  getMembership,
  roleLabelFor,
  sortCollections,
} from '~/components/Collections/collection-list.utils';

type Perm = { isCollaborator?: boolean; manage?: boolean };

describe('getMembership', () => {
  it('classifies an owned collection as owned regardless of permissions', () => {
    expect(getMembership({ isOwner: true }, { isCollaborator: true, manage: true })).toBe('owned');
  });

  it('classifies an elevated contributor row as shared', () => {
    expect(getMembership({ isOwner: false }, { isCollaborator: true })).toBe('shared');
  });

  // A follow row is a CollectionContributor row too. Having a row must never read as shared.
  it('classifies a non-elevated contributor row as following', () => {
    expect(getMembership({ isOwner: false }, { isCollaborator: false })).toBe('following');
  });

  it('falls back to following when permissions have not loaded yet', () => {
    expect(getMembership({ isOwner: false }, undefined)).toBe('following');
  });
});

describe('roleLabelFor', () => {
  it('labels a managing collaborator Manager', () => {
    expect(roleLabelFor({ isCollaborator: true, manage: true })).toBe('Manager');
  });

  it('labels a non-managing collaborator Contributor', () => {
    expect(roleLabelFor({ isCollaborator: true, manage: false })).toBe('Contributor');
  });

  it('returns null for a follower so no role renders', () => {
    expect(roleLabelFor({ isCollaborator: false, manage: false })).toBeNull();
  });
});

describe('sortCollections', () => {
  const rows = [{ id: 1, name: 'Beta' }, { id: 2, name: 'alpha' }, { id: 3, name: 'Gamma' }];

  it('sorts name-asc case-insensitively', () => {
    expect(sortCollections(rows, 'name-asc').map((r) => r.id)).toEqual([2, 1, 3]);
  });

  it('sorts name-desc case-insensitively', () => {
    expect(sortCollections(rows, 'name-desc').map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it('does not mutate the input array', () => {
    const input = [...rows];
    sortCollections(input, 'name-asc');
    expect(input.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});
