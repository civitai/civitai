import { randomInt } from 'node:crypto';

// Crockford base32: no I, L, O or U, so a reference read aloud or retyped can't be misread.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `TD-<yy>-<6 chars>`, about a billion per year; the unique index refuses the rare collision. */
export function newPublicRef(now = new Date()): string {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  let tail = '';
  for (let i = 0; i < 6; i++) tail += ALPHABET[randomInt(ALPHABET.length)];
  return `TD-${yy}-${tail}`;
}

export const PUBLIC_REF_PATTERN = /^TD-\d{2}-[0-9A-HJKMNP-TV-Z]{6}$/;
