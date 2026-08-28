import { describe, expect, it, vi } from 'vitest';

/**
 * Two properties of the strike list that nothing else checks. Both are silent when broken: the list
 * still renders, and both the typecheck and the SQL stay valid.
 *
 * 1. `internalNotes` is read for the legacy issuer name and must not leave the server — the rest of
 *    that field is a moderator's free text.
 * 2. `imported` marks a row the 08-21 import made INERT. The list says so in words beside it, so a
 *    row that still carries points must never wear that badge.
 */

// The module reaches `$lib/server/db` at import time, which would open a real pool.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { toLiveStrike } = await import('$lib/server/user-lookup.service');

const row = {
  id: 1,
  reason: 'ManualModAction',
  description: 'Repeat offender',
  points: 0,
  status: 'Expired',
  createdAt: new Date('2026-08-18'),
  expiresAt: new Date('2026-08-18'),
  voidedAt: null,
  issuedBy: null,
  issuerUsername: null,
  internalNotes: null,
};

describe('toLiveStrike', () => {
  it('never returns internalNotes', () => {
    const out = toLiveStrike({ ...row, internalNotes: 'Escalated after a call with the reporter' });

    expect(out).not.toHaveProperty('internalNotes');
    expect(JSON.stringify(out)).not.toContain('reporter');
  });

  it('prefers the resolved account over the legacy name', () => {
    // `issuedBy` is an id the import resolved; the marker name is what it fell back from. Reversing
    // this credits a Retool display name over the account the row actually points at.
    const out = toLiveStrike({
      ...row,
      issuedBy: 7,
      issuerUsername: 'live-moderator',
      internalNotes: 'retool:UserStrikes:2449 by Cameron',
    });

    expect(out.issuedByName).toBe('live-moderator');
  });

  it('falls back to the legacy name, and says so when there is neither', () => {
    expect(
      toLiveStrike({ ...row, internalNotes: 'retool:UserStrikes:2449 by Cameron' }).issuedByName
    ).toBe('Cameron');
    expect(toLiveStrike(row).issuedByName).toBeNull();
  });

  it('marks only the import that lands rows inert', () => {
    expect(
      toLiveStrike({ ...row, internalNotes: 'retool:UserStrikes:2449 by Cameron' }).imported
    ).toBe(true);
    // A first-pass row is Active with a point on the escalation ladder. Badging it "imported" would
    // hide its reason under a note saying imported strikes carry none.
    expect(
      toLiveStrike({
        ...row,
        status: 'Active',
        points: 1,
        internalNotes: 'Imported from Retool strike #123. Issued by: Sebastian',
      }).imported
    ).toBe(false);
    expect(toLiveStrike(row).imported).toBe(false);
  });
});
