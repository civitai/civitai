import { describe, it, expect } from 'vitest';
import { safeReturnPath } from '../return-path';
import { safeReturnPath as fromClient } from '../client';
import { safeReturnPath as fromIndex } from '../index';
import { SAFE_RETURN_PATHS, UNSAFE_RETURN_PATHS } from './return-path-cases';

describe('safeReturnPath', () => {
  it.each(UNSAFE_RETURN_PATHS)('refuses: %s', (_name, raw) => {
    expect(safeReturnPath(raw)).toBeNull();
  });

  it.each(SAFE_RETURN_PATHS)('keeps: %s', (_name, raw, expected) => {
    expect(safeReturnPath(raw)).toBe(expected);
  });

  it('rejects paths whose normalised form is not same-origin, but keeps ones that stay on it', () => {
    expect(safeReturnPath('/a/../../b')).toBe('/b');
    expect(safeReturnPath('/./b')).toBe('/b');
  });

  it('refuses non-strings', () => {
    for (const raw of [undefined, null, 42, ['/ok'], { toString: () => '/ok' }]) {
      expect(safeReturnPath(raw)).toBeNull();
    }
  });

  it('is the same function from the browser-safe and main entries', () => {
    expect(fromClient).toBe(safeReturnPath);
    expect(fromIndex).toBe(safeReturnPath);
  });
});
