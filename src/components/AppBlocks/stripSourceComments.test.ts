import { describe, expect, it } from 'vitest';
import { stripSourceComments } from './stripSourceComments';

/**
 * Both directions this has failed in, pinned as cases.
 *
 * Every "walks past" case below was a real, measured walk-past of a guard that
 * depends on this function; every "truncates" case was real over-stripping of
 * production source. A regex that fixes one has twice reintroduced the other,
 * so both directions are asserted together — that pairing is the point of the
 * file, not incidental coverage.
 */
describe('stripSourceComments', () => {
  describe('removes commented-out code (the walk-past direction)', () => {
    it('strips a line comment that opens the line', () => {
      const src = '      // await invalidateSharedStorageReads(trpcUtils);\n      real();';
      const out = stripSourceComments(src);
      expect(out).not.toContain('invalidateSharedStorageReads');
      expect(out).toContain('real()');
    });

    it('strips a TRAILING line comment after a statement', () => {
      // The regression round 3 introduced: an anchored regex left this intact,
      // so the guard read the call as present while it was gone.
      const src = 'void 0; // await invalidateSharedStorageReads(trpcUtils);';
      expect(stripSourceComments(src)).not.toContain('invalidateSharedStorageReads');
    });

    it('strips a trailing comment after a call expression', () => {
      const src = 'await fetch({ blockToken: token }); // BLOCK_STORAGE_READ_OPTS';
      expect(stripSourceComments(src)).not.toContain('BLOCK_STORAGE_READ_OPTS');
    });

    it('strips a block comment, inline or spanning lines', () => {
      expect(stripSourceComments('a(); /* await thing(); */ b();')).not.toContain('thing()');
      const multi = 'a();\n/*\n await thing();\n*/\nb();';
      const out = stripSourceComments(multi);
      expect(out).not.toContain('thing()');
      expect(out).toContain('a()');
      expect(out).toContain('b()');
    });
  });

  describe('preserves real code (the over-strip direction)', () => {
    it('keeps // inside a single-quoted string', () => {
      // The open-redirect guard an unanchored regex truncated mid-condition.
      const src = "if (cleaned.startsWith('/') || cleaned.includes('//')) {";
      expect(stripSourceComments(src)).toBe(src);
    });

    it('keeps a URL in a double-quoted string', () => {
      const src = 'const u = "https://example.com/x";';
      expect(stripSourceComments(src)).toBe(src);
    });

    it('keeps // inside a template literal', () => {
      const src = 'const u = `https://${host}/x`;';
      expect(stripSourceComments(src)).toBe(src);
    });

    it('is not fooled by an escaped quote before a //', () => {
      const src = "const s = 'it\\'s // not a comment';";
      expect(stripSourceComments(src)).toBe(src);
    });

    it('keeps a /* that lives inside a string', () => {
      const src = "const s = 'a /* b';\nreal();";
      expect(stripSourceComments(src)).toContain('/* b');
      expect(stripSourceComments(src)).toContain('real()');
    });
  });

  it('preserves line structure so line-oriented assertions stay aligned', () => {
    const src = 'a();\n// gone\nb();\n/*\n gone\n*/\nc();';
    const out = stripSourceComments(src);
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
  });
});
