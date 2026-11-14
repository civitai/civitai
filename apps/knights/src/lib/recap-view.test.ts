import { describe, expect, it } from 'vitest';
import type { Recap } from '$lib/server/daily/daily.service';
import { recapView } from './recap-view';

const recap = (over: Partial<Recap> = {}): Recap => ({
  day: '2026-12-14',
  when: 'yesterday',
  cast: 30,
  confirmed: 18,
  graded: 21,
  accuracy: 18 / 21,
  goldEarned: 1800,
  pending: 9,
  streakBonus: 0,
  ...over,
});

const stat = (view: ReturnType<typeof recapView>, key: string) =>
  view.stats.find((entry) => entry.key === key)?.value;

describe('recapView', () => {
  it('words the headline for yesterday and for an earlier day', () => {
    expect(recapView(recap()).headline).toBe("18 of yesterday's 30 judgments were confirmed");
    expect(recapView(recap({ when: 'on Oct 26' })).headline).toBe(
      '18 of your 30 judgments on Oct 26 were confirmed'
    );
  });

  it('agrees with a single judgment', () => {
    expect(
      recapView(recap({ cast: 1, confirmed: 1, graded: 1, accuracy: 1, pending: 0 })).headline
    ).toBe("1 of yesterday's 1 judgment was confirmed");
  });

  it('derives Missed from the settled votes consensus did not confirm, and Undecided from pending', () => {
    const view = recapView(recap());
    expect(stat(view, 'confirmed')).toBe('18');
    expect(stat(view, 'missed')).toBe('3');
    expect(stat(view, 'undecided')).toBe('9');
    expect(stat(view, 'accuracy')).toBe('86%');
  });

  it('shows no accuracy until something has settled', () => {
    const view = recapView(
      recap({ confirmed: 0, graded: 0, accuracy: null, goldEarned: 0, pending: 30 })
    );
    expect(stat(view, 'accuracy')).toBe('–');
    expect(stat(view, 'missed')).toBe('0');
  });

  it('states the gold earned and keeps the streak bonus apart from it', () => {
    const none = recapView(recap());
    expect(none.payout).toEqual({ gold: '+1,800 gold earned', note: '18 judgments confirmed' });
    const bonus = recapView(recap({ streakBonus: 700 }));
    expect(bonus.payout.gold).toBe('+1,800 gold earned');
    expect(bonus.payout.note).toBe('18 judgments confirmed · +700 streak bonus');
  });

  it('agrees the payout note with one confirmed judgment', () => {
    expect(recapView(recap({ confirmed: 1, graded: 1, accuracy: 1 })).payout.note).toBe(
      '1 judgment confirmed'
    );
  });
});
