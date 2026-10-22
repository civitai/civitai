import { describe, expect, it, vi } from 'vitest';

// `$lib/server/db` demands its replica URL at module scope.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { normalizeEmail, redactEmails } = await import('../email');

describe('normalizeEmail', () => {
  it.each([
    ['J.Doe+promo@Gmail.com', 'jdoe@gmail.com'],
    ['j.d.o.e@googlemail.com', 'jdoe@gmail.com'],
    ['  JDOE@GMAIL.COM ', 'jdoe@gmail.com'],
  ])('spells every Gmail variant of one inbox the same: %s', (email, inbox) => {
    expect(normalizeEmail(email)).toBe(inbox);
  });

  it('only lower-cases other providers, whose dot and plus rules differ', () => {
    expect(normalizeEmail('J.Doe+promo@Example.org')).toBe('j.doe+promo@example.org');
  });

  it.each(['', 'nobody', '@gmail.com', 'jdoe@', '+tag@gmail.com', '...@gmail.com'])(
    'has no inbox for %j',
    (email) => {
      expect(normalizeEmail(email)).toBeNull();
    }
  );
});

describe('redactEmails', () => {
  it('replaces each address and leaves the rest of the text', () => {
    expect(redactEmails('a.b+1@gmail.com and x@mail.example.co, on 192.0.2.16')).toBe(
      '[email] and [email], on 192.0.2.16'
    );
  });
});
