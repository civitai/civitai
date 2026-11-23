import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { EARNINGS_SOURCES } from '$lib/earnings';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Reported by a creator: a past month's chart read "this month vs <compare>".
function caption(range: { from: string; to: string }, throughIsToday: boolean) {
  const data = {
    summary: [{ source: EARNINGS_SOURCES[0], currency: 'yellow', total: 100, count: 1 }],
    series: null,
    cmpSummary: null,
    cmpSeries: null,
    cash: null,
    monthly: null,
    buzzRatio: null,
    compare: { key: '2026-08', label: 'Aug 2026', from: '2026-08-01', to: '2026-08-31' },
    through: throughIsToday ? '2026-09-20' : range.to,
    throughIsToday,
    range,
  };
  const body = render(Page, { props: { data: data as unknown as PageData } }).body;
  const at = body.indexOf('Buzz earned over time');
  expect(at).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf('</p>', at)).replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, '');
}

describe('/earnings "Buzz earned over time" caption', () => {
  it('names a past month rather than calling it this month', () => {
    const text = caption({ from: '2026-09-01', to: '2026-09-30' }, false);
    expect(text).toContain('Sep 2026 vs Aug 2026');
    expect(text).not.toContain('this month');
  });

  it('keeps "this month" for the current month', () => {
    expect(caption({ from: '2026-09-01', to: '2026-09-30' }, true)).toContain('this month vs Aug 2026');
  });
});
