import { describe, expect, it } from 'vitest';
import { latestPerTicket } from './sent-by';

describe('latestPerTicket', () => {
  it('keeps the newest escalation of each ticket', () => {
    const at = (d: string) => new Date(`2026-10-${d}T00:00:00Z`);
    const got = latestPerTicket([
      { entityId: 5, userId: 1, createdAt: at('20') },
      { entityId: 5, userId: 2, createdAt: at('25') },
      { entityId: 6, userId: 3, createdAt: at('22') },
    ]);
    expect(got.get('5')).toEqual({ moderatorId: 2, at: at('25').toISOString() });
    expect(got.get('6')).toEqual({ moderatorId: 3, at: at('22').toISOString() });
    expect(got.size).toBe(2);
  });

  it('skips rows without a ticket id', () => {
    expect(latestPerTicket([{ entityId: null, userId: 1, createdAt: new Date() }]).size).toBe(0);
  });
});
