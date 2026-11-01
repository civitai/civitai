import { describe, expect, it } from 'vitest';
import { carriedSearchParams, chipHref, rowChips } from '../filters';

const url = (search: string) => new URL(`http://x/models/flags/auto${search}`);
const group = { key: 'label', defaultValue: 'all', active: 'poi', toggle: true };

describe('chipHref', () => {
  it('selects an inactive value and drops page and selection', () => {
    expect(chipHref(url('?page=3&item=9'), group, 'minor', 'item')).toBe(
      '/models/flags/auto?label=minor'
    );
  });

  it('resets an active toggle chip to the default and drops page and selection', () => {
    expect(chipHref(url('?label=poi&page=3&item=9&sort=new'), group, 'poi', 'item')).toBe(
      '/models/flags/auto?sort=new'
    );
  });

  it('keeps an active non-toggle value instead of resetting it', () => {
    const sort = { key: 'sort', defaultValue: 'new', active: 'old' };
    expect(chipHref(url('?sort=old'), sort, 'old', 'item')).toBe('/models/flags/auto?sort=old');
  });

  it('clears the params a change makes stale, such as a sort tied to the status', () => {
    const status = { key: 'status', defaultValue: 'Pending', active: 'Pending', resets: ['sort'] };
    expect(chipHref(url('?sort=newest&page=2&item=9'), status, 'Upheld', 'item')).toBe(
      '/models/flags/auto?status=Upheld'
    );
  });

  it('drops the param when the value is the default', () => {
    const sort = { key: 'sort', defaultValue: 'new', active: 'old' };
    expect(chipHref(url('?sort=old&page=2'), sort, 'new', 'item')).toBe('/models/flags/auto');
  });
});

describe('carriedSearchParams', () => {
  it('keeps the tab filters and drops the search, page and selection params', () => {
    const params = new URLSearchParams(
      'label=poi&sort=new&q=cat&page=2&item=5&hold=8&appeal=6&model=7&label=minor'
    );
    expect(carriedSearchParams(params)).toEqual([
      ['label', 'poi'],
      ['sort', 'new'],
      ['label', 'minor'],
    ]);
  });

  it('drops the open item of a queue that names it `selected`', () => {
    expect(carriedSearchParams(new URLSearchParams('status=Upheld&selected=7&q=cat'))).toEqual([
      ['status', 'Upheld'],
    ]);
  });
});

describe('rowChips', () => {
  const flag = {
    key: 'flag',
    values: ['all', 'minor', 'poi'],
    defaultValue: 'all',
    active: 'all',
  };
  const source = {
    key: 'source',
    values: ['all', 'hash', 'text-scan', 'moderator'],
    defaultValue: 'all',
    active: 'all',
    toggle: true,
  };

  it('lists every chip in group order and drops the default chip of a toggle group', () => {
    expect(rowChips([flag, source]).map((c) => c.value)).toEqual([
      'all',
      'minor',
      'poi',
      'hash',
      'text-scan',
      'moderator',
    ]);
  });
});
