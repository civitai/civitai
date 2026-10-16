import { describe, expect, it } from 'vitest';
import { carriedSearchParams, chipHref } from '../filters';

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
