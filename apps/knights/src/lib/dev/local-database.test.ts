import { describe, expect, it } from 'vitest';
import { assertLocalDatabase } from './local-database';

describe('assertLocalDatabase', () => {
  it.each([
    'postgresql://u:p@localhost:5432/db',
    'postgres://u:p@127.0.0.1:6546/db?sslmode=disable',
  ])('accepts %s', (url) => {
    expect(() => assertLocalDatabase(url)).not.toThrow();
  });

  it.each([
    ['a remote host', 'postgresql://u:p@db.internal.example:5432/db'],
    ['a host that only starts with localhost', 'postgresql://u:p@localhost.example.com:5432/db'],
    ['a localhost user on a remote host', 'postgresql://localhost:p@db.example.com:5432/db'],
    ['a localhost path on a remote host', 'postgresql://u:p@db.example.com:5432/localhost'],
    ['another loopback spelling', 'postgresql://u:p@[::1]:5432/db'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertLocalDatabase(url)).toThrow(/Refusing to run/);
  });

  it('refuses a missing or unreadable connection string', () => {
    expect(() => assertLocalDatabase(undefined)).toThrow('DATABASE_URL is not set');
    expect(() => assertLocalDatabase('not a url')).toThrow('not a valid');
  });

  it('never prints the credentials', () => {
    expect(() => assertLocalDatabase('postgresql://user:secret@db.example.com/db')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret') })
    );
  });
});
