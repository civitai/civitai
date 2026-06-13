import { describe, expect, it } from 'vitest';
import {
  appRoleIdent,
  appSchemaIdent,
  isValidAppSlug,
  sanitizeAppSlug,
} from '~/server/utils/apps-slug';

describe('apps-slug', () => {
  describe('isValidAppSlug', () => {
    it('accepts a happy-path slug', () => {
      expect(isValidAppSlug('generate_from_model')).toBe(true);
    });

    it('accepts the shortest allowed slug (3 chars)', () => {
      expect(isValidAppSlug('abc')).toBe(true);
    });

    it('accepts the longest allowed slug (41 chars)', () => {
      expect(isValidAppSlug('a' + 'b'.repeat(40))).toBe(true);
      expect(isValidAppSlug('a' + 'b'.repeat(41))).toBe(false);
    });

    it('rejects empty + too-short slugs', () => {
      expect(isValidAppSlug('')).toBe(false);
      expect(isValidAppSlug('a')).toBe(false);
      expect(isValidAppSlug('ab')).toBe(false);
    });

    it('rejects leading digit', () => {
      expect(isValidAppSlug('1abc')).toBe(false);
    });

    it('rejects leading underscore', () => {
      expect(isValidAppSlug('_abc')).toBe(false);
    });

    it('rejects uppercase', () => {
      expect(isValidAppSlug('Abc')).toBe(false);
      expect(isValidAppSlug('ABC123')).toBe(false);
    });

    it('rejects hyphens, spaces, quotes, and other SQL-relevant chars', () => {
      expect(isValidAppSlug('abc-def')).toBe(false);
      expect(isValidAppSlug('abc def')).toBe(false);
      expect(isValidAppSlug("abc'def")).toBe(false);
      expect(isValidAppSlug('abc"def')).toBe(false);
      expect(isValidAppSlug('abc;def')).toBe(false);
      expect(isValidAppSlug('abc--def')).toBe(false);
      expect(isValidAppSlug('abc/*def*/')).toBe(false);
    });

    it('rejects unicode tricks', () => {
      expect(isValidAppSlug('abc​')).toBe(false); // zero-width space
      expect(isValidAppSlug('абв')).toBe(false); // Cyrillic
    });

    it('rejects non-strings', () => {
      expect(isValidAppSlug(null)).toBe(false);
      expect(isValidAppSlug(undefined)).toBe(false);
      expect(isValidAppSlug(123 as unknown)).toBe(false);
      expect(isValidAppSlug({} as unknown)).toBe(false);
    });
  });

  describe('sanitizeAppSlug', () => {
    it('passes through a valid slug', () => {
      expect(sanitizeAppSlug('generate_from_model')).toBe('generate_from_model');
    });

    it('lowercases + replaces hyphens with underscore', () => {
      expect(sanitizeAppSlug('Generate-From-Model')).toBe('generate_from_model');
    });

    it('collapses runs of non-alnum into a single underscore', () => {
      expect(sanitizeAppSlug('a-_-b---c')).toBe('a_b_c');
    });

    it('strips leading/trailing underscores from the normalized form', () => {
      expect(sanitizeAppSlug('--abc--')).toBe('abc');
    });

    it('returns null when normalization fails the regex', () => {
      expect(sanitizeAppSlug('')).toBe(null);
      expect(sanitizeAppSlug('!!')).toBe(null);
      // becomes '1abc' which fails leading-digit
      expect(sanitizeAppSlug('1-abc')).toBe(null);
    });

    it('is idempotent', () => {
      const out = sanitizeAppSlug('Generate-From-Model');
      expect(sanitizeAppSlug(out!)).toBe(out);
    });

    it('returns null for non-strings', () => {
      expect(sanitizeAppSlug(null as unknown as string)).toBe(null);
      expect(sanitizeAppSlug(undefined as unknown as string)).toBe(null);
    });
  });

  describe('identifier helpers', () => {
    it('produces quoted schema + role identifiers', () => {
      expect(appSchemaIdent('generate_from_model')).toBe('"app_generate_from_model"');
      expect(appRoleIdent('generate_from_model')).toBe('"app_generate_from_model_role"');
    });

    it('throws when invalid slug reaches the identifier helpers', () => {
      expect(() => appSchemaIdent('invalid-slug')).toThrow(/invalid app slug/);
      expect(() => appRoleIdent('')).toThrow(/invalid app slug/);
      expect(() => appSchemaIdent('1bad')).toThrow(/invalid app slug/);
    });
  });
});
