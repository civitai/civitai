import { describe, expect, it } from 'vitest';
import { reportDetailEntries } from '$lib/reports';

describe('reportDetailEntries', () => {
  it('lists primitive values as strings', () => {
    expect(reportDetailEntries({ comment: 'spam', count: 3, flagged: true })).toEqual([
      ['comment', 'spam'],
      ['count', '3'],
      ['flagged', 'true'],
    ]);
  });

  it('drops null, undefined and blank values', () => {
    expect(reportDetailEntries({ a: null, b: undefined, c: '', d: '   ', e: 'kept' })).toEqual([
      ['e', 'kept'],
    ]);
  });

  it('returns nothing for a non-object', () => {
    expect(reportDetailEntries(null)).toEqual([]);
    expect(reportDetailEntries('spam')).toEqual([]);
  });

  // 🔴 The row this helper renders is the `entity === 'other'` one — a report whose target is
  // gone. A snapshot written so that report can still be ruled on is a nested object, so
  // filtering objects out hid it on the one surface it exists for.
  it('renders a nested object rather than dropping it', () => {
    expect(
      reportDetailEntries({
        announcement: { title: 'Free stuff', content: 'grab it at [here](https://t.me/x)' },
      })
    ).toEqual([
      ['announcement', '{"title":"Free stuff","content":"grab it at [here](https://t.me/x)"}'],
    ]);
  });

  it('renders an array value', () => {
    expect(reportDetailEntries({ links: ['https://t.me/x', 'https://t.me/y'] })).toEqual([
      ['links', '["https://t.me/x","https://t.me/y"]'],
    ]);
  });
});
