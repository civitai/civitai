import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { Session } from '~/types/session';
import { SESSION_DATE_FIELDS, jsonSafeSession } from '~/server/utils/session-props';

const sessionWith = (user: Record<string, unknown>) =>
  ({ user, expires: '2030-01-01T00:00:00.000Z' } as unknown as Session);

const userOf = (session: Session | null) => session?.user as unknown as Record<string, unknown>;

// Mirrors what Next's `isSerializableProps` rejects: any Date anywhere under the props object.
function findDates(value: unknown, at = 'session'): string[] {
  if (value instanceof Date) return [at];
  if (Array.isArray(value)) return value.flatMap((v, i) => findDates(v, `${at}[${i}]`));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => findDates(v, `${at}.${k}`));
  return [];
}

describe('jsonSafeSession', () => {
  it('converts every Date field to an ISO string', () => {
    const session = sessionWith(
      Object.fromEntries(SESSION_DATE_FIELDS.map((f) => [f, new Date('2024-03-04T05:06:07.000Z')]))
    );

    const safe = jsonSafeSession(session);

    for (const field of SESSION_DATE_FIELDS) {
      // typeof first: a Date and its ISO string print identically in the diff, so asserting the value
      // alone reports `expected <date> to be '<same text>'` and reads like a bug in the test.
      expect(typeof userOf(safe)[field], `${field} must be a string in props, not a Date`).toBe(
        'string'
      );
      expect(userOf(safe)[field]).toBe('2024-03-04T05:06:07.000Z');
    }
    expect(findDates(safe), 'no Date may survive into props').toEqual([]);
  });

  // The cold-miss path (hub HTTP JSON) already hands us ISO strings, so normalizing must not depend on
  // which side of the session cache the request landed on.
  it('leaves ISO strings, absent fields and null alone', () => {
    const safe = jsonSafeSession(
      sessionWith({ id: 1, createdAt: '2024-03-04T05:06:07.000Z', mutedAt: null })
    );

    expect(userOf(safe).createdAt).toBe('2024-03-04T05:06:07.000Z');
    expect(userOf(safe).mutedAt).toBeNull();
    expect(userOf(safe).emailVerified).toBeUndefined();
    expect(userOf(safe).id).toBe(1);
  });

  it('passes through a null session and a session with no user', () => {
    expect(jsonSafeSession(null)).toBeNull();
    expect(jsonSafeSession({ expires: 'x' } as Session)).toEqual({ expires: 'x' });
  });

  it('does not mutate the session it was given', () => {
    const createdAt = new Date('2024-03-04T05:06:07.000Z');
    const session = sessionWith({ createdAt });

    jsonSafeSession(session);

    expect(userOf(session).createdAt).toBe(createdAt);
  });

  // A Date field added to SessionUser and not listed in SESSION_DATE_FIELDS is a page-wide dev 500 that
  // nothing else catches: the type says Date, and no runtime check reads the type.
  it('lists every Date-typed field on SessionUser', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../types/session.ts'), 'utf8');
    const body = source.slice(source.indexOf('interface SessionUser'));
    const declared = [...body.slice(0, body.indexOf('\n}')).matchAll(/^\s*(\w+)\??:\s*Date/gm)].map(
      (m) => m[1]
    );

    expect(
      declared.length,
      'failed to parse SessionUser — fix this test, not the list'
    ).toBeGreaterThan(0);
    expect(declared.sort()).toEqual([...SESSION_DATE_FIELDS].sort());
  });
});
