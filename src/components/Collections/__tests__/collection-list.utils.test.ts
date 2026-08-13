import { describe, expect, it } from 'vitest';
import {
  buildCollectionSections,
  getMembership,
  roleLabelFor,
  sortCollections,
} from '~/components/Collections/collection-list.utils';

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

describe('buildCollectionSections', () => {
  const owned = { id: 1, isOwner: true };
  const elevated = { id: 2, isOwner: false };
  const followed = { id: 3, isOwner: false };
  const rows = [owned, elevated, followed];

  const flatten = (sections: ReturnType<typeof buildCollectionSections>) =>
    sections.flatMap((s) => s.rows.map((r) => r.id));

  it('groups an elevated row under shared', () => {
    const sections = buildCollectionSections(
      rows,
      new Map([[elevated.id, { isCollaborator: true }]])
    );
    expect(sections.find((s) => s.key === 'shared')?.rows.map((r) => r.id)).toEqual([elevated.id]);
  });

  // The feature flag payload is sparse, so an off flag reads as `undefined` and the permissions
  // query can still be skipped without any flag check reaching here. A non-owned row must stay
  // reachable in that window rather than being dropped from every section.
  it('keeps every row reachable when no permissions are available', () => {
    const sections = buildCollectionSections(rows, new Map());
    expect(flatten(sections).sort()).toEqual([owned.id, elevated.id, followed.id].sort());
    expect(sections.find((s) => s.key === 'following')?.rows.map((r) => r.id)).toEqual([
      elevated.id,
      followed.id,
    ]);
  });

  it('always emits all three sections so none can be filtered away', () => {
    expect(buildCollectionSections([], new Map()).map((s) => s.key)).toEqual([
      'owned',
      'shared',
      'following',
    ]);
  });

  it('places each row in exactly one section', () => {
    const sections = buildCollectionSections(
      rows,
      new Map([
        [elevated.id, { isCollaborator: true }],
        [followed.id, { isCollaborator: false }],
      ])
    );
    expect(flatten(sections)).toHaveLength(rows.length);
  });

  it('preserves the incoming order within a section', () => {
    const sorted = sortCollections(
      [
        { id: 4, isOwner: false, name: 'Zeta' },
        { id: 5, isOwner: false, name: 'alpha' },
      ],
      'name-asc'
    );
    const sections = buildCollectionSections(sorted, new Map());
    expect(sections.find((s) => s.key === 'following')?.rows.map((r) => r.id)).toEqual([5, 4]);
  });
});

describe('sortCollections', () => {
  const rows = [
    { id: 1, name: 'Beta' },
    { id: 2, name: 'alpha' },
    { id: 3, name: 'Gamma' },
  ];

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

describe('sortCollections date modes', () => {
  const rows = [
    { name: 'beta', createdAt: '2026-01-02', updatedAt: '2026-03-01' },
    { name: 'alpha', createdAt: '2026-01-03', updatedAt: '2026-02-01' },
    { name: 'gamma', createdAt: null, updatedAt: null },
  ];

  it('orders recently-added newest first and sinks undated rows', () => {
    expect(sortCollections(rows, 'recently-added').map((r) => r.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('orders recently-updated independently of createdAt', () => {
    expect(sortCollections(rows, 'recently-updated').map((r) => r.name)).toEqual([
      'beta',
      'alpha',
      'gamma',
    ]);
  });

  it('still sorts by name when dates are absent entirely', () => {
    const undated = [{ name: 'b' }, { name: 'a' }];
    expect(sortCollections(undated, 'recently-added').map((r) => r.name)).toEqual(['a', 'b']);
  });
});
