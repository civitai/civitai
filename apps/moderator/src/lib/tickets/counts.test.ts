import { describe, expect, it } from 'vitest';
import { TICKET_COUNT_KEYS, countTicketViews } from './counts';
import type { Snapshot, TicketRecord } from './snapshot';

const ticket = (over: Partial<TicketRecord>): TicketRecord => ({
  id: '1',
  subject: 's',
  status: 2,
  cfFeature: null,
  tags: [],
  createdAt: null,
  updatedAt: null,
  routerTopic: null,
  ...over,
});

const snapshot = (tickets: TicketRecord[]): Snapshot => ({
  tickets,
  syncedAt: 0,
  attemptedAt: 0,
  fullAt: 0,
  needsFull: false,
  readWarnings: [],
  routerFailed: false,
  lastError: null,
});

describe('countTicketViews', () => {
  it('counts each live ticket in the view it routes to', () => {
    const counts = countTicketViews(
      snapshot([
        ticket({ id: '1', cfFeature: 'Moderation Decision' }),
        ticket({ id: '2', status: 8 }),
        ticket({ id: '3', cfFeature: 'Billing' }),
        ticket({ id: '4' }),
        ticket({ id: '5', cfFeature: 'Moderation Decision', tags: ['sent-to-support'] }),
      ])
    );
    expect(counts).toEqual({
      [TICKET_COUNT_KEYS.moderation]: 2,
      [TICKET_COUNT_KEYS.support]: 3,
    });
  });

  it('reports zero for an empty view rather than leaving it out', () => {
    expect(countTicketViews(snapshot([]))).toEqual({
      [TICKET_COUNT_KEYS.moderation]: 0,
      [TICKET_COUNT_KEYS.support]: 0,
    });
  });

  it('has no counts without a snapshot', () => {
    expect(countTicketViews(null)).toEqual({});
  });
});
