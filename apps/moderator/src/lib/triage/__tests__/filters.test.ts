import { describe, expect, it } from 'vitest';
import { carriedSearchParams, chipHref, splitChips } from '../filters';

const url = (search: string) => new URL(`http://x/models/flags/review${search}`);
const group = { key: 'label', defaultValue: 'all', active: 'poi', toggle: true };

describe('chipHref', () => {
  it('selects an inactive value and drops page and selection', () => {
    expect(chipHref(url('?page=3&item=9'), group, 'minor', 'item')).toBe(
      '/models/flags/review?label=minor'
    );
  });

  it('resets an active toggle chip to the default and drops page and selection', () => {
    expect(chipHref(url('?label=poi&page=3&item=9&sort=new'), group, 'poi', 'item')).toBe(
      '/models/flags/review?sort=new'
    );
  });

  it('keeps an active non-toggle value instead of resetting it', () => {
    const sort = { key: 'sort', defaultValue: 'new', active: 'old' };
    expect(chipHref(url('?sort=old'), sort, 'old', 'item')).toBe('/models/flags/review?sort=old');
  });

  it('drops the param when the value is the default', () => {
    const sort = { key: 'sort', defaultValue: 'new', active: 'old' };
    expect(chipHref(url('?sort=old&page=2'), sort, 'new', 'item')).toBe('/models/flags/review');
  });
});

describe('carriedSearchParams', () => {
  it('keeps the tab filters and drops the search, page and selection params', () => {
    const params = new URLSearchParams(
      'label=poi&sort=new&q=cat&page=2&item=5&appeal=6&model=7&label=minor'
    );
    expect(carriedSearchParams(params)).toEqual([
      ['label', 'poi'],
      ['sort', 'new'],
      ['label', 'minor'],
    ]);
  });
});

describe('splitChips', () => {
  const flag = {
    key: 'flag',
    values: ['all', 'minor', 'poi', 'unflagged'],
    more: ['unflagged'],
    defaultValue: 'all',
    active: 'all',
  };
  const source = {
    key: 'source',
    values: ['hash', 'text-scan', 'moderator', 'none'],
    more: ['moderator', 'none'],
    defaultValue: 'all',
    active: 'all',
    toggle: true,
  };

  it('keeps the overflow values off the row and lists them under More', () => {
    const { row, more } = splitChips([flag, source]);
    expect(row.map((c) => c.value)).toEqual(['all', 'minor', 'poi', 'hash', 'text-scan']);
    expect(more.map((c) => c.value)).toEqual(['unflagged', 'moderator', 'none']);
  });

  it('shows an active overflow value on the row, so the filter in force stays visible', () => {
    const { row, more } = splitChips([flag, { ...source, active: 'none' }]);
    expect(row.map((c) => c.value)).toContain('none');
    expect(more.map((c) => c.value)).toEqual(['unflagged', 'moderator']);
  });

  it('drops the default chip of a toggle group', () => {
    const { row } = splitChips([{ ...source, values: ['all', ...source.values] }]);
    expect(row.map((c) => c.value)).not.toContain('all');
  });
});
