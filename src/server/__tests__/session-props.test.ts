import fs from 'fs';
import path from 'path';
// Next's REAL props validator — the rule that was actually being violated. Asserting against our own
// idea of "serializable" is what let an earlier version of this fix pass while Next still rejected the
// props: it checked for Dates and missed `undefined`.
import { isSerializableProps } from 'next/dist/lib/is-serializable-props';
import { describe, expect, it } from 'vitest';
import type { Session } from '~/types/session';
import { jsonSafeSession } from '~/server/utils/session-props';

const asProps = (session: Session | null) => ({ session, adsGated: false });
const serializable = (session: Session | null) => () =>
  isSerializableProps('/models', 'getServerSideProps', asProps(session));

// What a warm `session:data2` msgpack hit actually yields: real Dates AND keys present with `undefined`
// (shapeSessionUser assigns explicit undefined to ~20 optional fields).
const cachedSession = () =>
  ({
    user: {
      id: 1,
      username: 'ivy',
      createdAt: new Date('2024-03-04T05:06:07.000Z'),
      emailVerified: new Date('2024-03-04T05:06:07.000Z'),
      mutedAt: undefined,
      bannedAt: undefined,
      deletedAt: undefined,
      leaderboardShowcase: undefined,
      tier: undefined,
      meta: { firstImage: new Date('2024-03-04T05:06:07.000Z') },
    },
    expires: '2030-01-01T00:00:00.000Z',
  } as unknown as Session);

const userOf = (session: Session | null) => session?.user as unknown as Record<string, unknown>;

describe('jsonSafeSession', () => {
  it('produces props Next accepts, where the raw session does not', () => {
    const raw = cachedSession();

    expect(serializable(raw), 'the raw cached session must be the thing Next rejects').toThrow();
    expect(serializable(jsonSafeSession(raw))).not.toThrow();
  });

  it('ISO-strings Dates and drops undefined keys', () => {
    const safe = jsonSafeSession(cachedSession());

    expect(typeof userOf(safe).createdAt).toBe('string');
    expect(userOf(safe).createdAt).toBe('2024-03-04T05:06:07.000Z');
    expect('mutedAt' in userOf(safe), 'an undefined key must be gone, not merely undefined').toBe(
      false
    );
  });

  // A shallow field-by-field pass cannot reach these; SessionUser.meta declares four z.date() fields.
  it('recurses into nested values', () => {
    const safe = jsonSafeSession(cachedSession());

    expect((userOf(safe).meta as Record<string, unknown>).firstImage).toBe(
      '2024-03-04T05:06:07.000Z'
    );
  });

  it('is idempotent on the ISO strings the cold-miss HTTP path returns', () => {
    const once = jsonSafeSession(cachedSession());

    expect(jsonSafeSession(once)).toEqual(once);
  });

  it('passes through a null session and a session with no user', () => {
    expect(jsonSafeSession(null)).toBeNull();
    expect(jsonSafeSession({ expires: 'x' } as Session)).toEqual({ expires: 'x' });
  });

  it('does not mutate the session it was given', () => {
    const session = cachedSession();

    jsonSafeSession(session);

    expect(userOf(session).createdAt).toBeInstanceOf(Date);
  });

  // An invalid date must not become a throw: this runs on every SSR render, including in production,
  // where the unnormalized value used to pass through harmlessly.
  it('does not throw on a malformed date', () => {
    const safe = jsonSafeSession({
      user: { id: 1, createdAt: new Date('nope') },
    } as unknown as Session);

    expect(userOf(safe).createdAt).toBeNull();
    expect(serializable(safe)).not.toThrow();
  });

  // The load-bearing edge: the helper is worthless if it isn't applied. A unit test cannot drive
  // createServerSideProps without wholesale-mocking `~/server/routers` (banned by no-wholesale-module-mock),
  // so pin the call site itself.
  describe('the call site in createServerSideProps', () => {
    const source = () =>
      fs.readFileSync(path.resolve(__dirname, '../utils/server-side-helpers.ts'), 'utf8');

    it('applies jsonSafeSession to the session prop', () => {
      expect(source()).toContain('session: jsonSafeSession(session)');
    });

    // `session` must stay the LAST key in the props object: a later spread would re-add the raw
    // session over the sanitized one, which leaves the call above present but dead.
    it('keeps it last, so nothing can spread a raw session over it', () => {
      expect(
        source(),
        'nothing may be added after `session:` in the returned props object'
      ).toMatch(/session: jsonSafeSession\(session\),\s*\}\s*as NonNullable<P>/);
    });
  });
});
