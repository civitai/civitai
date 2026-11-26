import { describe, expect, it } from 'vitest';
import { inquisitorStats } from './inquisitor-home';

const values = (...args: Parameters<typeof inquisitorStats>) =>
  inquisitorStats(...args).map((stat) => stat.value);

describe('inquisitorStats', () => {
  it('shows the waiting count, the week of votes and the agreement rate', () => {
    expect(
      values({ waiting: 312, waitingMore: false, votesThisWeek: 1048, agreementRate: 0.912 })
    ).toEqual(['312', '1,048', '91.2%']);
  });

  it('marks a waiting count past the cap with a plus', () => {
    expect(
      values({ waiting: 1000, waitingMore: true, votesThisWeek: 0, agreementRate: null })[0]
    ).toBe('1,000+');
  });

  it('shows a dash for what could not be read or has no closed review yet', () => {
    expect(
      values({ waiting: null, waitingMore: false, votesThisWeek: 3, agreementRate: null })
    ).toEqual(['—', '3', '—']);
    expect(values(null)).toEqual(['—', '—', '—']);
  });
});
