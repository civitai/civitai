import { describe, expect, it } from 'vitest';
import {
  adjustPublishedRange,
  publishedDateParam,
  publishedDateSchema,
  publishedRangeBounds,
  publishedRangeError,
} from '~/shared/utils/published-range';

describe('publishedRangeBounds', () => {
  it('starts at midnight UTC of `from`, inclusive', () => {
    const { gte } = publishedRangeBounds({ from: '2024-12-01' });
    expect(gte?.toISOString()).toBe('2024-12-01T00:00:00.000Z');
  });

  it('ends at the midnight after `to`, exclusive, so the whole last day is in', () => {
    const { lt } = publishedRangeBounds({ to: '2024-12-31' });
    expect(lt?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('treats a one-day range as that day only', () => {
    const { gte, lt } = publishedRangeBounds({ from: '2024-02-29', to: '2024-02-29' });
    expect(gte?.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(lt?.toISOString()).toBe('2024-03-01T00:00:00.000Z');
  });

  it('leaves an open end unbounded', () => {
    expect(publishedRangeBounds({ from: '2024-12-01' }).lt).toBeUndefined();
    expect(publishedRangeBounds({ to: '2024-12-31' }).gte).toBeUndefined();
    expect(publishedRangeBounds({})).toEqual({ gte: undefined, lt: undefined });
  });
});

describe('publishedDateSchema', () => {
  it.each(['2024-12-01', '2024-02-29'])('accepts %s', (value) => {
    expect(publishedDateSchema.safeParse(value).success).toBe(true);
  });

  // `new Date('2024-02-31')` rolls over to March in some engines; a rolled date would
  // silently bound the wrong day.
  it.each(['2024-02-31', '2023-02-29', '2024-13-01', '2024-1-1', 'December 2024', ''])(
    'rejects %s',
    (value) => {
      expect(publishedDateSchema.safeParse(value).success).toBe(false);
    }
  );

  it('lets a junk URL value fall away instead of failing the object it sits in', () => {
    expect(publishedDateParam.parse('2024-02-31')).toBeUndefined();
    expect(publishedDateParam.parse('2024-12-01')).toBe('2024-12-01');
  });
});

describe('publishedRangeError', () => {
  it('accepts no range, a one-day range and a 31-day span', () => {
    expect(publishedRangeError({})).toBeUndefined();
    expect(publishedRangeError({ from: '2024-12-05', to: '2024-12-05' })).toBeUndefined();
    expect(publishedRangeError({ from: '2024-12-01', to: '2025-01-01' })).toBeUndefined();
  });

  it('refuses a span past 31 days', () => {
    expect(publishedRangeError({ from: '2024-12-01', to: '2025-01-02' })).toMatch(
      /at most 31 days/
    );
  });

  it('refuses half a range and a reversed one', () => {
    expect(publishedRangeError({ from: '2024-12-01' })).toMatch(/both/);
    expect(publishedRangeError({ to: '2024-12-31' })).toMatch(/both/);
    expect(publishedRangeError({ from: '2024-12-31', to: '2024-12-01' })).toMatch(/before/);
  });
});

describe('adjustPublishedRange', () => {
  it('fills the empty end with the same day', () => {
    expect(adjustPublishedRange({ from: '2024-12-05' }, 'from')).toEqual({
      from: '2024-12-05',
      to: '2024-12-05',
    });
    expect(adjustPublishedRange({ to: '2024-12-05' }, 'to')).toEqual({
      from: '2024-12-05',
      to: '2024-12-05',
    });
  });

  it('pulls the other end along when an edit reverses the range', () => {
    expect(adjustPublishedRange({ from: '2024-12-20', to: '2024-12-10' }, 'from')).toEqual({
      from: '2024-12-20',
      to: '2024-12-20',
    });
    expect(adjustPublishedRange({ from: '2024-12-20', to: '2024-12-10' }, 'to')).toEqual({
      from: '2024-12-10',
      to: '2024-12-10',
    });
  });

  it('pulls the other end along when an edit would span more than 31 days', () => {
    expect(adjustPublishedRange({ from: '2024-10-01', to: '2024-12-31' }, 'from')).toEqual({
      from: '2024-10-01',
      to: '2024-11-01',
    });
    expect(adjustPublishedRange({ from: '2024-10-01', to: '2024-12-31' }, 'to')).toEqual({
      from: '2024-11-30',
      to: '2024-12-31',
    });
  });

  it('clears both ends when one is cleared', () => {
    expect(adjustPublishedRange({ from: undefined, to: '2024-12-31' }, 'from')).toEqual({
      from: undefined,
      to: undefined,
    });
  });

  // Whatever the edit, the result must be something the server accepts.
  it.each([
    [{ from: '2020-01-01', to: '2024-12-31' }, 'from'],
    [{ from: '2020-01-01', to: '2024-12-31' }, 'to'],
    [{ from: '2024-12-31', to: '2020-01-01' }, 'from'],
    [{ from: '2024-12-31', to: '2020-01-01' }, 'to'],
  ] as const)('always yields a valid pair: %j edited %s', (range, edited) => {
    expect(publishedRangeError(adjustPublishedRange(range, edited))).toBeUndefined();
  });
});
