import { describe, expect, it } from 'vitest';
import type { AccountLinkRow } from '$lib/linked-accounts';
import { reconcileSelection, toggleId } from '../account-links';

const SUBJECT = 100;
const row = (userId: number, extra: Partial<AccountLinkRow> = {}): AccountLinkRow => ({
  userId,
  username: `u${userId}`,
  status: 'active',
  muted: false,
  strikes: 0,
  ...extra,
});

const strong = row(1, {
  status: 'banned',
  nearLogin: { ips: ['1.1.1.1'], addresses: 1, closestSeconds: 5, logins: 3 },
  buzz: { rank: 1, inCount: 9, outCount: 9, inAmount: 900, outAmount: 900 },
});

describe('Bulk Ban selection', () => {
  it('selects nothing a moderator did not tick, however strong the evidence', () => {
    expect(reconcileSelection([], [strong, row(2)], SUBJECT)).toEqual([]);
  });

  it('drops a tick whose row a refetch removed, and keeps the subject and rows still shown', () => {
    const ticked = toggleId(toggleId(toggleId([], 1), 2), SUBJECT);
    expect(reconcileSelection(ticked, [strong], SUBJECT)).toEqual([1, SUBJECT]);
  });

  it('untoggles', () => {
    expect(toggleId(toggleId([], 7), 7)).toEqual([]);
  });
});
