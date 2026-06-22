import { describe, it, expect } from 'vitest';
import {
  USER_CODE_CHARSET,
  USER_CODE_GROUP_SIZE,
  USER_CODE_LENGTH,
  formatUserCode,
  isUserCodeComplete,
  normalizeUserCode,
} from '~/server/oauth/user-code';

// Pure format helpers shared by the server generator and the client entry page
// (the single source of truth for the `XXXX-XXXX` user-code shape). These pin
// the normalize/format/completeness contract the device-entry UX relies on.

describe('user-code format', () => {
  it('charset has the expected length and omits look-alikes (I/O/0/1)', () => {
    expect(USER_CODE_CHARSET).not.toMatch(/[IO01]/);
    expect(USER_CODE_LENGTH).toBe(8);
    expect(USER_CODE_GROUP_SIZE).toBe(4);
  });

  describe('normalizeUserCode', () => {
    it('strips the hyphen and uppercases', () => {
      expect(normalizeUserCode('49xa-amh2')).toBe('49XAAMH2');
    });

    it('strips surrounding/embedded whitespace', () => {
      expect(normalizeUserCode('  49XA AMH2 ')).toBe('49XAAMH2');
    });
  });

  describe('formatUserCode', () => {
    it('inserts the grouping hyphen for a full code', () => {
      expect(formatUserCode('49XAAMH2')).toBe('49XA-AMH2');
    });

    it('is idempotent on an already-formatted code', () => {
      expect(formatUserCode('49XA-AMH2')).toBe('49XA-AMH2');
    });

    it('lowercases are canonicalized to the hyphenated upper form', () => {
      expect(formatUserCode('49xaamh2')).toBe('49XA-AMH2');
    });

    it('does not prematurely hyphenate partial input at/under the group size', () => {
      expect(formatUserCode('49XA')).toBe('49XA');
      expect(formatUserCode('49X')).toBe('49X');
      expect(formatUserCode('')).toBe('');
    });
  });

  describe('isUserCodeComplete', () => {
    it('is true only at the full normalized length, hyphen or not', () => {
      expect(isUserCodeComplete('49XA-AMH2')).toBe(true);
      expect(isUserCodeComplete('49XAAMH2')).toBe(true);
      expect(isUserCodeComplete('49xa-amh2')).toBe(true);
    });

    it('is false for partial, empty, or over-length input', () => {
      expect(isUserCodeComplete('')).toBe(false);
      expect(isUserCodeComplete('49XA')).toBe(false);
      expect(isUserCodeComplete('49XA-AMH')).toBe(false); // 7 chars
      expect(isUserCodeComplete('49XA-AMH23')).toBe(false); // 9 chars
    });
  });
});
