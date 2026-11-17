import { describe, expect, it } from 'vitest';
import {
  canonicalIframeSrc,
  stampCanonicalIframeSrc,
  trimManifestStringFields,
} from '../manifest-normalize';

describe('manifest-normalize', () => {
  describe('canonicalIframeSrc', () => {
    it('builds the per-app subdomain root', () => {
      expect(canonicalIframeSrc('hello', 'civit.ai')).toBe('https://hello.civit.ai/');
    });
  });

  describe('stampCanonicalIframeSrc', () => {
    it('creates the iframe object when the manifest omits it', () => {
      const m: Record<string, unknown> = { blockId: 'hello', version: '0.1.0' };
      stampCanonicalIframeSrc(m, 'hello', 'civit.ai');
      expect((m.iframe as any).src).toBe('https://hello.civit.ai/');
    });

    it('overwrites a dev-supplied (wrong) src and preserves other iframe fields', () => {
      const m: Record<string, unknown> = {
        iframe: { src: 'https://attacker.example/x/', minHeight: 300, sandbox: 'allow-scripts' },
      };
      stampCanonicalIframeSrc(m, 'hello', 'civit.ai');
      const iframe = m.iframe as any;
      expect(iframe.src).toBe('https://hello.civit.ai/');
      expect(iframe.minHeight).toBe(300);
      expect(iframe.sandbox).toBe('allow-scripts');
    });

    it('normalizes a near-canonical src missing the trailing slash', () => {
      const m: Record<string, unknown> = { iframe: { src: 'https://hello.civit.ai' } };
      stampCanonicalIframeSrc(m, 'hello', 'civit.ai');
      expect((m.iframe as any).src).toBe('https://hello.civit.ai/');
    });

    it('ignores a non-object iframe value and replaces it', () => {
      const m: Record<string, unknown> = { iframe: 'nonsense' };
      stampCanonicalIframeSrc(m, 'hello', 'civit.ai');
      expect((m.iframe as any).src).toBe('https://hello.civit.ai/');
    });

    it('mutates and returns the same manifest object', () => {
      const m: Record<string, unknown> = {};
      const out = stampCanonicalIframeSrc(m, 'hello', 'civit.ai');
      expect(out).toBe(m);
    });

    it('uses the supplied appsDomain', () => {
      const m: Record<string, unknown> = {};
      stampCanonicalIframeSrc(m, 'who-am-i', 'apps.example.test');
      expect((m.iframe as any).src).toBe('https://who-am-i.apps.example.test/');
    });
  });

  describe('trimManifestStringFields', () => {
    const TAGLINE = 'Pitch: ' + 'abcdefghij'.repeat(13) + 'xyz';
    const REPO = 'https://github.com/example-org/example-app';

    it('trims tagline and repository on both ends', () => {
      const m: Record<string, unknown> = {
        tagline: ` \t\n${' '.repeat(400)}${TAGLINE}${' '.repeat(400)}\n\t `,
        repository: `\n  ${REPO}  \t`,
      };
      trimManifestStringFields(m);
      expect(TAGLINE).toHaveLength(140);
      expect(m.tagline).toBe(TAGLINE);
      expect(m.repository).toBe(REPO);
    });

    it('leaves other string fields, non-string values and absent keys alone', () => {
      const m: Record<string, unknown> = {
        name: '  Padded Name  ',
        description: '  padded description  ',
        bugs: '  https://github.com/example-org/example-app/issues  ',
        tagline: 42,
      };
      trimManifestStringFields(m);
      expect(m).toEqual({
        name: '  Padded Name  ',
        description: '  padded description  ',
        bugs: '  https://github.com/example-org/example-app/issues  ',
        tagline: 42,
      });
      expect('repository' in m).toBe(false);
    });

    it('mutates and returns the same manifest object', () => {
      const m: Record<string, unknown> = { tagline: ' x ' };
      expect(trimManifestStringFields(m)).toBe(m);
      expect(m.tagline).toBe('x');
    });
  });
});
