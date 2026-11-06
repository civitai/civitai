import { timingSafeEqual } from 'crypto';

/** Compares two strings in constant time. Strings of different lengths are never equal. */
export function timingSafeEqualStrings(a: string, b: string | undefined) {
  if (typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
