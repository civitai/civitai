import { describe, expect, it } from 'vitest';
import { NONE } from './view-query';
import { NO_VALUE_LABEL, statusOptions, syncedAgo, toggleHref, valueOptions } from './filters';

describe('statusOptions', () => {
  it('lists live statuses that hold tickets, in status order, with their labels', () => {
    const opts = statusOptions([], { '3': 2, '2': 5, '6': 0 });
    expect(opts).toEqual([
      { value: '2', label: 'Open', count: 5, active: false },
      { value: '3', label: 'Pending', count: 2, active: false },
    ]);
  });

  it('keeps a selected status even when nothing matches it', () => {
    const opts = statusOptions([6], { '2': 1, '6': 0 });
    expect(opts.find((o) => o.value === '6')).toEqual({
      value: '6',
      label: 'Waiting on Customer',
      count: 0,
      active: true,
    });
  });
});

describe('valueOptions', () => {
  it('orders by count then name, hides empty values, and names the none bucket', () => {
    const opts = valueOptions(['x'], { b: 2, a: 2, [NONE]: 7, c: 0 }, 'No feature');
    expect(opts.map((o) => [o.value, o.label, o.count])).toEqual([
      [NONE, 'No feature', 7],
      ['a', 'a', 2],
      ['b', 'b', 2],
      ['x', 'x', 0],
    ]);
    expect(opts.find((o) => o.value === 'x')?.active).toBe(true);
  });

  it('has a default label for the none bucket', () => {
    expect(valueOptions([], { [NONE]: 1 })[0].label).toBe(NO_VALUE_LABEL);
  });
});

describe('toggleHref', () => {
  const url = new URL(
    'https://x.test/tickets/support?status=2&feature=A&page=3&ticket=77&q=hello&sort=created'
  );

  it('adds a value, keeping other filters, and drops the page and the open ticket', () => {
    const href = toggleHref(url, 'status', '3', ['page', 'ticket']);
    const next = new URL(href, url);
    expect(next.pathname).toBe('/tickets/support');
    expect(next.searchParams.getAll('status')).toEqual(['2', '3']);
    expect(next.searchParams.get('feature')).toBe('A');
    expect(next.searchParams.get('q')).toBe('hello');
    expect(next.searchParams.get('sort')).toBe('created');
    expect(next.searchParams.has('page')).toBe(false);
    expect(next.searchParams.has('ticket')).toBe(false);
  });

  it('removes a selected value, and leaves no empty param behind when it was the last', () => {
    const next = new URL(toggleHref(url, 'status', '2', ['page', 'ticket']), url);
    expect(next.searchParams.has('status')).toBe(false);
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
