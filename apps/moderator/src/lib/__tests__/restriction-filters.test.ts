import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESTRICTION_FILTERS,
  ORIGIN_FILTERS,
  RESTRICTION_ORIGIN_LABELS,
  RESTRICTION_STATUS_LABELS,
  RESTRICTION_STATUSES,
  restrictionFilterParams,
  resolveRestrictionFilters,
} from '../restriction-filters';
import { SORT_ORDERS } from '../restriction-types';

describe('resolveRestrictionFilters', () => {
  it('opens on pending, every origin, oldest first', () => {
    expect(resolveRestrictionFilters({})).toEqual(DEFAULT_RESTRICTION_FILTERS);
    expect(DEFAULT_RESTRICTION_FILTERS).toEqual({
      status: 'Pending',
      origin: 'all',
      sort: 'oldest',
    });
  });

  it('defaults the sort to the status: newest first once a row is ruled', () => {
    expect(resolveRestrictionFilters({ status: 'Upheld' }).sort).toBe('newest');
    expect(resolveRestrictionFilters({ status: 'any' }).sort).toBe('newest');
    expect(resolveRestrictionFilters({ status: 'Pending' }).sort).toBe('oldest');
  });

  it('keeps an explicit sort whatever the status', () => {
    expect(resolveRestrictionFilters({ status: 'Pending', sort: 'newest' }).sort).toBe('newest');
    expect(resolveRestrictionFilters({ status: 'Upheld', sort: 'oldest' }).sort).toBe('oldest');
  });
});

describe('restrictionFilterParams', () => {
  it('writes nothing for the defaults', () => {
    expect(restrictionFilterParams(DEFAULT_RESTRICTION_FILTERS)).toEqual({});
  });

  it('writes only what differs from the default for that status', () => {
    expect(restrictionFilterParams({ status: 'Upheld', origin: 'remix', sort: 'newest' })).toEqual({
      status: 'Upheld',
      origin: 'remix',
    });
    expect(restrictionFilterParams({ status: 'Upheld', origin: 'all', sort: 'oldest' })).toEqual({
      status: 'Upheld',
      sort: 'oldest',
    });
  });
});

describe('vocabulary', () => {
  it('labels every status and origin the URL can carry', () => {
    for (const s of RESTRICTION_STATUSES) expect(RESTRICTION_STATUS_LABELS[s]).toBeTruthy();
    for (const o of ['all', ...ORIGIN_FILTERS] as const)
      expect(RESTRICTION_ORIGIN_LABELS[o]).toBeTruthy();
    expect(SORT_ORDERS).toEqual(['oldest', 'newest']);
  });
});
