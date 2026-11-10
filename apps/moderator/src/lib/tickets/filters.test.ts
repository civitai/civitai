import { describe, expect, it } from 'vitest';
import { NONE } from './view-query';
import {
  NO_VALUE_LABEL,
  clearFiltersHref,
  optionText,
  parseSortValue,
  selectionHref,
  sentOptions,
  sortValue,
  statusOptions,
  syncedAgo,
  triggerText,
  valueOptions,
  visibleFilters,
} from './filters';

describe('statusOptions', () => {
  it('lists every live status in status order with its count, so an empty one can be dimmed', () => {
    const opts = statusOptions([], { '3': 2, '2': 5, '6': 0 });
    expect(opts.map((o) => [o.value, o.count])).toEqual([
      ['2', 5],
      ['3', 2],
      ['6', 0],
      ['7', 0],
      ['8', 0],
      ['9', 0],
      ['9000', 0],
    ]);
    expect(opts[0]).toEqual({ value: '2', label: 'Open', count: 5, active: false });
  });

  it('marks the selected statuses active', () => {
    const opts = statusOptions([6], { '2': 1 });
    expect(opts.find((o) => o.value === '6')).toEqual({
      value: '6',
      label: 'Waiting on Customer',
      count: 0,
      active: true,
    });
  });
});

describe('valueOptions', () => {
  it('orders by count then name, keeps empty values, and names the none bucket', () => {
    const opts = valueOptions(['x'], { b: 2, a: 2, [NONE]: 7, c: 0 }, 'No feature');
    expect(opts.map((o) => [o.value, o.label, o.count])).toEqual([
      [NONE, 'No feature', 7],
      ['a', 'a', 2],
      ['b', 'b', 2],
      ['c', 'c', 0],
      ['x', 'x', 0],
    ]);
    expect(opts.find((o) => o.value === 'x')?.active).toBe(true);
  });

  it('has a default label for the none bucket', () => {
    expect(valueOptions([], { [NONE]: 1 })[0].label).toBe(NO_VALUE_LABEL);
  });
});

describe('visibleFilters', () => {
  it('shows only the status control in the moderation view, where feature and topic define the queue', () => {
    expect(visibleFilters('moderation')).toEqual(['status']);
  });

  it('adds feature, router topic and sent-to-support in the support view', () => {
    expect(visibleFilters('support')).toEqual(['status', 'feature', 'topic', 'sent']);
  });
});

describe('triggerText', () => {
  it('names the dimension alone when nothing is selected', () => {
    expect(triggerText('Status', 0)).toBe('Status');
  });
  it('adds how many are selected', () => {
    expect(triggerText('Status', 2)).toBe('Status · 2');
  });
});

describe('optionText', () => {
  it('reads label then count', () => {
    expect(optionText({ label: 'Waiting on Mod Lead', count: 131 })).toBe(
      'Waiting on Mod Lead 131'
    );
  });
});

describe('sentOptions', () => {
  it('offers all, sent and not sent with their counts; all carries the total', () => {
    expect(sentOptions({ only: 3, exclude: 9 })).toEqual([
      { value: '', label: 'All', count: 12 },
      { value: 'only', label: 'Sent by moderators', count: 3 },
      { value: 'exclude', label: 'Not sent', count: 9 },
    ]);
  });
});

describe('sort value', () => {
  it('joins and splits sort and direction', () => {
    expect(sortValue('created', 'asc')).toBe('created:asc');
    expect(parseSortValue('created:asc')).toEqual({ sort: 'created', dir: 'asc' });
  });
  it('falls back to newest-updated on a bad value', () => {
    expect(parseSortValue('nope')).toEqual({ sort: 'updated', dir: 'desc' });
  });
});

describe('selectionHref', () => {
  const url = new URL(
    'https://x.test/tickets/support?status=2&feature=A&page=3&ticket=77&q=hello&sort=created'
  );

  it('replaces the values, keeping other filters, and drops the page and the open ticket', () => {
    const next = new URL(selectionHref(url, 'status', ['2', '3'], ['page', 'ticket']), url);
    expect(next.pathname).toBe('/tickets/support');
    expect(next.searchParams.getAll('status')).toEqual(['2', '3']);
    expect(next.searchParams.get('feature')).toBe('A');
    expect(next.searchParams.get('q')).toBe('hello');
    expect(next.searchParams.get('sort')).toBe('created');
    expect(next.searchParams.has('page')).toBe(false);
    expect(next.searchParams.has('ticket')).toBe(false);
  });

  it('leaves no empty param behind when nothing is selected', () => {
    const next = new URL(selectionHref(url, 'status', [], ['page', 'ticket']), url);
    expect(next.searchParams.has('status')).toBe(false);
  });
});

describe('clearFiltersHref', () => {
  it('removes every filter, the page and the open ticket, and keeps the search and the sort', () => {
    const url = new URL(
      'https://x.test/tickets/support?status=2&status=3&feature=A&topic=t&sent=only&page=3&ticket=77&q=hello&sort=created&dir=asc'
    );
    const next = new URL(clearFiltersHref(url, ['page', 'ticket']), url);
    expect([...next.searchParams.keys()].sort()).toEqual(['dir', 'q', 'sort']);
  });
});

describe('syncedAgo', () => {
  const now = 1_000_000_000;
  it.each([
    [now - 10_000, 'just now'],
    [now - 90_000, '1m ago'],
    [now - 3 * 3_600_000, '3h ago'],
    [now + 5_000, 'just now'],
  ])('%#', (at, text) => expect(syncedAgo(at, now)).toBe(text));
});
