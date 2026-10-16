import { describe, expect, it } from 'vitest';

import {
  reactTicketForImage,
  signReactTicket,
  verifyReactTicket,
} from '~/server/services/blocks/react-ticket.service';
import { REACT_TICKET_TTL_SECONDS } from '~/shared/constants/block-reaction.constants';

const SECRET = 'unit-secret';
const NOW = 1_800_000_000;
const SUBJECT = {
  entityType: 'image' as const,
  entityId: 9001,
  appBlockId: 'apb_alpha',
  sub: 'user:42',
};

describe('react tickets', () => {
  it('a ticket verifies for exactly the (entity, app, viewer) it was signed for', () => {
    const ticket = signReactTicket(SUBJECT, { secret: SECRET, nowSeconds: NOW });
    expect(verifyReactTicket(ticket, SUBJECT, { secret: SECRET, nowSeconds: NOW })).toEqual({
      ok: true,
    });
  });

  it.each([
    ['another image', { entityId: 9002 }],
    ['another app', { appBlockId: 'apb_other' }],
    ['another viewer', { sub: 'user:7' }],
  ])('does NOT verify for %s', (_label, change) => {
    const ticket = signReactTicket(SUBJECT, { secret: SECRET, nowSeconds: NOW });
    expect(
      verifyReactTicket(ticket, { ...SUBJECT, ...change }, { secret: SECRET, nowSeconds: NOW })
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('expires after the TTL, and not before', () => {
    const ticket = signReactTicket(SUBJECT, { secret: SECRET, nowSeconds: NOW });
    const justBefore = NOW + REACT_TICKET_TTL_SECONDS - 1;
    const atExpiry = NOW + REACT_TICKET_TTL_SECONDS;
    expect(verifyReactTicket(ticket, SUBJECT, { secret: SECRET, nowSeconds: justBefore }).ok).toBe(
      true
    );
    expect(verifyReactTicket(ticket, SUBJECT, { secret: SECRET, nowSeconds: atExpiry })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('a pushed-out expiry does not verify — the expiry is inside the signature', () => {
    const ticket = signReactTicket(SUBJECT, { secret: SECRET, nowSeconds: NOW });
    const [v, exp, sig] = ticket.split('.');
    const extended = [v, String(Number(exp) + 86_400), sig].join('.');
    expect(verifyReactTicket(extended, SUBJECT, { secret: SECRET, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('refuses a ticket signed with another secret', () => {
    const ticket = signReactTicket(SUBJECT, { secret: 'other', nowSeconds: NOW });
    expect(verifyReactTicket(ticket, SUBJECT, { secret: SECRET, nowSeconds: NOW }).ok).toBe(false);
  });

  it.each([
    // A well-formed ticket whose signature is SHORTER or LONGER than a real one: reaches the
    // length check before the constant-time compare, which would otherwise throw.
    ['v1.1900000000.short', 'mismatch'],
    [`v1.1900000000.${'a'.repeat(100)}`, 'mismatch'],
    // Over the wire cap, but otherwise well-formed: refused by the length cap itself.
    [`v1.1900000000.${'a'.repeat(260)}`, 'malformed'],
  ])('refuses %s as %s without throwing', (input, reason) => {
    expect(verifyReactTicket(input, SUBJECT, { secret: SECRET, nowSeconds: NOW })).toEqual({
      ok: false,
      reason,
    });
  });

  it.each([undefined, '', 123, 'v1.abc.def', 'v2.1900000000.sig', 'x'.repeat(300)])(
    'never throws on malformed input %#',
    (input) => {
      const verdict = verifyReactTicket(input, SUBJECT, { secret: SECRET, nowSeconds: NOW });
      expect(verdict.ok).toBe(false);
    }
  );

  it('an anonymous token is handed no ticket; a signed-in one is', () => {
    expect(
      reactTicketForImage({ sub: 'anon', appBlockId: 'apb_alpha' }, 1, { secret: SECRET })
    ).toBe(undefined);
    const t = reactTicketForImage({ sub: 'user:42', appBlockId: 'apb_alpha' }, 1, {
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(typeof t).toBe('string');
    expect(
      verifyReactTicket(t, { ...SUBJECT, entityId: 1 }, { secret: SECRET, nowSeconds: NOW }).ok
    ).toBe(true);
  });
});
