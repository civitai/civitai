import { describe, expect, it } from 'vitest';
import { findInlineMediaPath, inlineMediaMessage } from '~/server/schema/blocks/inline-media';

/** A base64-alphabet run of exactly `n` characters, using every character class. */
const base64Run = (n: number) => 'Qm+/ZTY0aW5saW5l'.repeat(Math.ceil(n / 16)).slice(0, n);

describe('inline-media predicate', () => {
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

  describe('past the value budget it fails closed', () => {
    const pad = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1]));

    it('reports too-many-values, not null, for one oversized value', () => {
      expect(findInlineMediaPath({ ...pad(300_000), photo: 'data:image/png;base64,iVBOR' })).toBe(
        'too-many-values'
      );
    });

    it('spends one budget across every field it is passed', () => {
      const budget = { visits: 0 };
      expect(findInlineMediaPath(pad(150_000), budget)).toBeNull();
      expect(findInlineMediaPath(pad(150_000), budget)).toBe('too-many-values');
    });
  });

  describe('with a byte limit', () => {
    const LIMIT = 262_144;
    const nearMiss = `${base64Run(100_000)} `; // all of it is read, then it fails

    it('stops reading strings once the ones it passed exceed the limit', () => {
      const budget = { visits: 0 };
      const value = { items: new Array(2_000).fill(nearMiss) };
      expect(findInlineMediaPath(value, budget, LIMIT)).toBe('over-byte-limit');
      expect(budget.inspected).toBeLessThanOrEqual(LIMIT + nearMiss.length);
    });

    it('still finds media in the string that crosses the limit', () => {
      const photo = `data:image/jpeg;base64,${base64Run(LIMIT)}`;
      expect(findInlineMediaPath({ pad: 'x'.repeat(1_000), photo }, { visits: 0 }, LIMIT)).toEqual([
        'photo',
      ]);
    });

    it('does not count strings JSON.stringify does not write', () => {
      const photo = 'data:image/png;base64,iVBOR';
      const hidden = { toJSON: () => 'short', text: '.'.repeat(LIMIT * 2) };
      expect(findInlineMediaPath({ hidden, photo }, { visits: 0 }, LIMIT)).toEqual(['photo']);
      // A boxed string is written as one string, not as its one-character entries.
      const boxed = new String('.'.repeat(100_000));
      expect(findInlineMediaPath({ boxed, photo }, { visits: 0 }, LIMIT)).toEqual(['photo']);
      const list = Object.assign(['.'.repeat(LIMIT)], { toJSON: () => [] });
      expect(findInlineMediaPath({ list, photo }, { visits: 0 }, LIMIT)).toEqual(['photo']);
      // Nor anything further down.
      const deep = { toJSON: () => 'short', nested: { text: '.'.repeat(LIMIT * 2) } };
      expect(findInlineMediaPath({ deep, photo }, { visits: 0 }, LIMIT)).toEqual(['photo']);
    });

    it('never counts past the JSON length of a body that fits', () => {
      const photo = 'data:image/png;base64,iVBOR';
      // Short strings make the count closest to the real length: 3 counted of 4 written each.
      const input = { s: new Array(65_000).fill('a'), photo };
      expect(JSON.stringify(input).length).toBeLessThan(LIMIT);
      expect(findInlineMediaPath(input, { visits: 0 }, LIMIT)).toEqual(['photo']);
      // And one long string, which a count scaled by length would overshoot.
      const long = { s: '.'.repeat(200_000), photo };
      expect(JSON.stringify(long).length).toBeLessThan(LIMIT);
      expect(findInlineMediaPath(long, { visits: 0 }, LIMIT)).toEqual(['photo']);
    });

    it('still reports a body past the value budget as too many values', () => {
      const cyclic: Record<string, unknown> = { s: '.'.repeat(LIMIT) };
      cyclic.self = cyclic;
      expect(findInlineMediaPath(cyclic, { visits: 0 }, LIMIT)).toBe('too-many-values');
    });

    it('leaves a photo after the limit to the byte cap', () => {
      const photo = 'data:image/png;base64,iVBOR';
      expect(findInlineMediaPath({ pad: '.'.repeat(LIMIT), photo }, { visits: 0 }, LIMIT)).toBe(
        'over-byte-limit'
      );
    });
  });

  it('survives nesting deep enough to overflow a recursive walk', () => {
    let deep: unknown = 'data:image/png;base64,AA';
    for (let i = 0; i < 100_000; i++) deep = { d: deep };
    expect(findInlineMediaPath(deep)).toHaveLength(100_000);
  });

  it('names the path and the fix in its message', () => {
    expect(inlineMediaMessage(['steps', 1, 'input', 'images', 0])).toBe(
      'steps[1].input.images[0] carries inline media (data URI/base64); ' +
        'pass a hosted url instead — upload the image, video or audio with useMediaUpload ' +
        "(an image also works with useImageUpload({ purpose: 'generationSource' }) or useImagePicker) and pass the returned url"
    );
  });
});
