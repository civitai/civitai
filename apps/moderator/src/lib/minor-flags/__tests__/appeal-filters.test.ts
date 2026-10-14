import { describe, expect, it } from 'vitest';
import {
  appealFacets,
  appealFilterParams,
  DEFAULT_APPEAL_FILTERS,
  effectiveSource,
  matchesFlag,
  sourceKey,
  sourceLabel,
  type AppealGroup,
} from '../appeal-filters';

describe('sourceKey', () => {
  it.each([
    ['text-scan', 'text-scan'],
    ['auto', 'hash'],
    ['manual', 'moderator'],
    [null, 'none'],
    ['something-new', 'none'],
  ])('maps %s to %s', (raw, key) => {
    expect(sourceKey(raw)).toBe(key);
  });
});

describe('effectiveSource', () => {
  it.each([
    ['manual', 'auto', 'hash'],
    ['manual', 'text-scan', 'text-scan'],
    ['manual', null, 'moderator'],
    ['manual', 'manual', 'moderator'],
    ['auto', 'text-scan', 'hash'],
    [null, 'auto', 'none'],
  ])('%s confirmed from %s is %s', (source, confirmedFrom, expected) => {
    expect(effectiveSource(source, confirmedFrom)).toBe(expected);
  });
});

describe('sourceLabel', () => {
  it('names a hash match that a moderator later affirmed', () => {
    expect(sourceLabel('manual', 'auto')).toBe('Moderator (was hash match)');
  });
  it('names a text scan that a moderator later affirmed', () => {
    expect(sourceLabel('manual', 'text-scan')).toBe('Moderator (was text scan)');
  });
  it('does not claim a hash origin for a plain moderator flag', () => {
    expect(sourceLabel('manual', null)).toBe('Moderator');
  });
  it('labels the other sources', () => {
    expect(sourceLabel('auto', null)).toBe('Hash match');
    expect(sourceLabel('text-scan', null)).toBe('Text scan');
    expect(sourceLabel(null, null)).toBe('No flag record');
  });
});

describe('matchesFlag', () => {
  it('treats unflagged as neither minor nor poi', () => {
    expect(matchesFlag('unflagged', { minor: false, poi: false })).toBe(true);
    expect(matchesFlag('unflagged', { minor: false, poi: true })).toBe(false);
  });
  it('matches a model carrying both labels under each', () => {
    const both = { minor: true, poi: true };
    expect(matchesFlag('minor', both) && matchesFlag('poi', both)).toBe(true);
  });
});

const groups: AppealGroup[] = [
  { source: 'manual', minor: true, poi: false, count: 5 },
  { source: 'manual', minor: false, poi: false, count: 2 },
  { source: 'auto', minor: true, poi: true, count: 3 },
  { source: 'text-scan', minor: false, poi: true, count: 1 },
  { source: null, minor: false, poi: false, count: 1 },
];

describe('appealFacets', () => {
  it('counts every appeal with no filter', () => {
    const f = appealFacets(groups, DEFAULT_APPEAL_FILTERS);
    expect(f.source).toEqual({ all: 12, 'text-scan': 1, hash: 3, moderator: 7, none: 1 });
    expect(f.flag).toEqual({ all: 12, minor: 8, poi: 4, unflagged: 3 });
  });

  it('counts sources under the selected flag', () => {
    const f = appealFacets(groups, { ...DEFAULT_APPEAL_FILTERS, flag: 'minor' });
    expect(f.source).toEqual({ all: 8, 'text-scan': 0, hash: 3, moderator: 5, none: 0 });
  });

  it('counts flags under the selected source', () => {
    const f = appealFacets(groups, { ...DEFAULT_APPEAL_FILTERS, source: 'moderator' });
    expect(f.flag).toEqual({ all: 7, minor: 5, poi: 0, unflagged: 2 });
  });
});

describe('appealFilterParams', () => {
  it('omits defaults so the bare URL stays the default view', () => {
    expect(appealFilterParams(DEFAULT_APPEAL_FILTERS)).toEqual({});
    expect(appealFilterParams({ source: 'hash', flag: 'all', sort: 'newest' })).toEqual({
      source: 'hash',
      sort: 'newest',
    });
  });
});
