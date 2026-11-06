import { describe, expect, it, vi } from 'vitest';
import { peekTicketCounts } from '../tickets/view-counts';
import type { Snapshot } from '$lib/tickets/snapshot';

const snapshot = (tickets: Snapshot['tickets']): Snapshot => ({
  tickets,
  syncedAt: 0,
  attemptedAt: 0,
  fullAt: 0,
  needsFull: false,
  readWarnings: [],
  routerFailed: false,
  lastError: null,
});

const t = (id: string, status: number) => ({
  id,
  subject: '',
  status,
  cfFeature: null,
  tags: [],
  createdAt: null,
  updatedAt: null,
});

describe('peekTicketCounts', () => {
  it('counts the stored snapshot', async () => {
    const peek = vi.fn(async () => snapshot([t('1', 8), t('2', 2), t('3', 2)]));
    expect(await peekTicketCounts(peek)).toEqual({ ticketsModeration: 1, ticketsSupport: 2 });
  });

  it('has no counts when no snapshot is stored', async () => {
    expect(await peekTicketCounts(async () => null)).toEqual({});
  });

  it('has no counts, and does not throw, when the cache cannot be read', async () => {
    const peek = async (): Promise<Snapshot> => {
      throw new Error('redis down');
    };
    expect(await peekTicketCounts(peek)).toEqual({});
  });
});
