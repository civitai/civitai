import { describe, expect, it } from 'vitest';
import {
  findInlineMediaPath,
  INLINE_MEDIA_DATA_URI_REGEX,
  INLINE_MEDIA_RAW_BASE64_MIN_CHARS,
  INLINE_MEDIA_RAW_BASE64_REGEX,
  inlineMediaMessage,
} from '~/server/schema/blocks/inline-media';

/** A base64-alphabet run of exactly `n` characters, using every character class. */
const base64Run = (n: number) => 'Qm+/ZTY0aW5saW5l'.repeat(Math.ceil(n / 16)).slice(0, n);

describe('inline-media predicate', () => {
  // The SDK mock host mirrors these verbatim; a change here is a change there.
  it('pins the mirrored regexes and threshold', () => {
    expect(INLINE_MEDIA_DATA_URI_REGEX.source).toBe('^\\s*data:(image|video|audio)\\/');
    expect(INLINE_MEDIA_DATA_URI_REGEX.flags).toBe('i');
    expect(INLINE_MEDIA_RAW_BASE64_REGEX.source).toBe('^[A-Za-z0-9+/]+={0,2}$');
    expect(INLINE_MEDIA_RAW_BASE64_MIN_CHARS).toBe(4096);
  });

  describe('data URIs', () => {
    it.each([
      ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='],
      ['  DATA:Image/png;base64,iVBORw0KGgo='],
      ['data:video/mp4;base64,AAAAIGZ0eXA='],
      ['data:audio/mpeg;base64,SUQzBAA='],
    ])('refuses %s at the top level', (uri) => {
      expect(findInlineMediaPath({ ImageUrl: uri })).toEqual(['ImageUrl']);
    });

    it('refuses one nested in an object', () => {
      const input = {
        prompt: 'a cat',
        source: { meta: { image: 'data:image/webp;base64,UklGR' } },
      };
      expect(findInlineMediaPath(input)).toEqual(['source', 'meta', 'image']);
    });

    it('refuses one in an array, at its index', () => {
      const input = {
        images: ['https://image.civitai.com/a.jpeg', 'data:image/png;base64,iVBOR'],
      };
      expect(findInlineMediaPath(input)).toEqual(['images', 1]);
    });

    it('returns the FIRST offender only', () => {
      const input = { a: 'data:image/png;base64,AA', b: 'data:image/png;base64,BB' };
      expect(findInlineMediaPath(input)).toEqual(['a']);
    });

    it('accepts a non-media data URI and a prompt that merely mentions one', () => {
      expect(findInlineMediaPath({ note: 'data:text/plain,hello' })).toBeNull();
      expect(findInlineMediaPath({ prompt: 'explain data:image/png URIs' })).toBeNull();
    });
  });

  describe('raw base64', () => {
    it('refuses a run of exactly 4096 characters', () => {
      expect(findInlineMediaPath({ blob: base64Run(4096) })).toEqual(['blob']);
    });

    it('refuses a padded run of 4096 characters', () => {
      expect(findInlineMediaPath({ blob: `${base64Run(4094)}==` })).toEqual(['blob']);
    });

    it('accepts a run one character shorter', () => {
      expect(findInlineMediaPath({ blob: base64Run(4095) })).toBeNull();
    });

    it('accepts a long run broken by whitespace or a non-alphabet character', () => {
      expect(findInlineMediaPath({ blob: `${base64Run(3000)} ${base64Run(3000)}` })).toBeNull();
      expect(findInlineMediaPath({ blob: `${base64Run(3000)}.${base64Run(3000)}` })).toBeNull();
    });
  });

  describe('what it lets through', () => {
    it('accepts hosted urls, short strings, long prose and non-strings', () => {
      const input = {
        image: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/abc/width=1024/photo.jpeg',
        seed: 42,
        flag: true,
        none: null,
        short: 'QUJD',
        prompt: 'a watercolor fox in a misty forest, '.repeat(300),
      };
      expect(input.prompt.length).toBeGreaterThan(4096);
      expect(findInlineMediaPath(input)).toBeNull();
    });

    it('accepts a `$ref` object', () => {
      expect(
        findInlineMediaPath({ image: { $ref: 'gen', path: 'output.images[0].url' } })
      ).toBeNull();
    });
  });

  it('does not overflow the stack on pathological nesting', () => {
    let deep: unknown = 'data:image/png;base64,AA';
    for (let i = 0; i < 100_000; i++) deep = { d: deep };
    expect(() => findInlineMediaPath(deep)).not.toThrow();
  });

  it('names the path and the fix in its message', () => {
    expect(inlineMediaMessage(['steps', 1, 'input', 'images', 0])).toBe(
      'step input field steps[1].input.images[0] carries inline media (data URI/base64); ' +
        "pass a hosted url instead — for an image, upload it with useImageUpload({ purpose: 'generationSource' }) " +
        'or pick it with useImagePicker and pass the returned url'
    );
  });
});
