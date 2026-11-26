import { generateHTML, generateJSON } from '@tiptap/html';
import Link from '@tiptap/extension-link';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import {
  restoreWithheldMedia,
  withheldMediaPlaceholders,
} from '~/server/utils/article-withheld-media';
import { withWithheldHref } from '~/shared/tiptap/withheld-link';

const HIDDEN = '11111111-aaaa-4bbb-8ccc-111111111111';
const SHOWN = '22222222-aaaa-4bbb-8ccc-222222222222';
const img = (uuid: string) =>
  `<img src="https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${uuid}/width=450">`;
const stored =
  `<p>one</p>${img(SHOWN)}<p>two ${img(HIDDEN)} three</p>` +
  `<edge-media url="${HIDDEN}" type="video"></edge-media><p>end</p>`;
const hidden = new Set([HIDDEN]);

describe('the edit form body', () => {
  const edited = withheldMediaPlaceholders(stored, hidden);

  it('names no hidden image, and keeps the shown one', () => {
    expect(edited).not.toContain(HIDDEN);
    expect(edited).toContain(img(SHOWN));
    expect(edited.match(/data-type="withheldMedia"/g)).toHaveLength(2);
  });

  it('🔴 swaps a medium nested in another once, as part of the outer one', () => {
    const nested = `<edge-media url="${HIDDEN}">${img(HIDDEN)}</edge-media><p>end</p>`;
    const out = withheldMediaPlaceholders(nested, hidden);
    expect(out).not.toContain(HIDDEN);
    expect(out.match(/data-type="withheldMedia"/g)).toHaveLength(1);
    expect(out.match(/<p>end<\/p>/g)).toHaveLength(1);
  });

  it('🔴 saves back byte for byte when nothing changed', () => {
    expect(restoreWithheldMedia(edited, stored, hidden)).toBe(stored);
  });

  it('survives the save sanitizer', () => {
    const sanitized = getSanitizedStringSchema({ allowBlurbs: true }).parse(edited);
    expect(restoreWithheldMedia(sanitized, stored, hidden)).toContain(img(HIDDEN));
  });

  it('keeps the other placeholders when one is deleted', () => {
    const [first] = edited.match(/<span data-type="withheldMedia" data-id="\d+"><\/span>/)!;
    const restored = restoreWithheldMedia(edited.replace(first, ''), stored, hidden);
    expect(restored).not.toContain(img(HIDDEN));
    expect(restored).toContain(`<edge-media url="${HIDDEN}"`);
  });

  it.each([
    ['a shown image', 0],
    ['no stored image', 9],
  ])('🔴 refuses a placeholder that names %s', (_, ref) => {
    const forged = `<p>x</p><span data-type="withheldMedia" data-id="${ref}"></span>`;
    expect(() => restoreWithheldMedia(forged, stored, hidden)).toThrow(
      'This article body names an image it does not hold'
    );
  });

  it('🔴 refuses one placeholder named twice', () => {
    const twice = `<span data-type="withheldMedia" data-id="1"></span>`.repeat(2);
    expect(() => restoreWithheldMedia(twice, stored, hidden)).toThrow(
      'This article body names an image it does not hold'
    );
  });

  it('🔴 refuses any placeholder on a body with nothing stored', () => {
    const forged = `<span data-type="withheldMedia" data-id="0"></span>`;
    expect(() => restoreWithheldMedia(forged, null, hidden)).toThrow(
      'This article body names an image it does not hold'
    );
  });

  it('leaves a body without placeholders untouched (control)', () => {
    expect(restoreWithheldMedia('<p>new</p>', stored, hidden)).toBe('<p>new</p>');
    expect(withheldMediaPlaceholders(stored, new Set())).toBe(stored);
  });
});

describe('a link to a hidden image on the edit form', () => {
  const href = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${HIDDEN}/original=true`;
  const linked =
    `<p>see <a href="${href}" target="_blank" rel="noopener">it</a> and ` +
    `<a href="https://civitai.com/models/1">a model</a></p>`;
  const edited = withheldMediaPlaceholders(linked, hidden);

  it('names no hidden image, and keeps the other link', () => {
    expect(edited).not.toContain(HIDDEN);
    expect(edited).toContain('<a data-withheld-href="0" target="_blank" rel="noopener">it</a>');
    expect(edited).toContain('<a href="https://civitai.com/models/1">a model</a>');
  });

  it('saves back byte for byte when nothing changed', () => {
    expect(restoreWithheldMedia(edited, linked, hidden)).toBe(linked);
  });

  it('survives the editor and the save sanitizer', () => {
    const extensions = [StarterKit.configure({ link: false }), withWithheldHref(Link)];
    const fromEditor = generateHTML(generateJSON(edited, extensions), extensions);
    const sanitized = getSanitizedStringSchema().parse(fromEditor);
    const restored = restoreWithheldMedia(sanitized, linked, hidden);
    expect(restored).toContain(`href="${href}"`);
    expect(restored).not.toContain('data-withheld-href');
    expect(restored.match(/href=/g)).toHaveLength(2);
  });

  it('loses the ref in an editor without it (control)', () => {
    const extensions = [StarterKit.configure({ link: false }), Link];
    expect(generateHTML(generateJSON(edited, extensions), extensions)).not.toContain(
      'data-withheld-href'
    );
  });

  it('🔴 refuses a ref to a link that names no hidden image', () => {
    const forged = edited.replace(
      '<a href="https://civitai.com/models/1">',
      '<a data-withheld-href="1">'
    );
    expect(() => restoreWithheldMedia(forged, linked, hidden)).toThrow(
      'This article body names an image it does not hold'
    );
  });

  it('🔴 refuses a ref used twice', () => {
    const twice = `${edited}<p><a data-withheld-href="0">again</a></p>`;
    expect(() => restoreWithheldMedia(twice, linked, hidden)).toThrow(
      'This article body names an image it does not hold'
    );
  });
});

describe('a link ref with nothing behind it', () => {
  it.each([
    ['past the stored links', '<p><a data-withheld-href="7">it</a></p>', '<p>no links</p>'],
    ['on a body with nothing stored', '<p><a data-withheld-href="0">it</a></p>', null],
  ])('🔴 is refused %s', (_, saved, storedBody) => {
    expect(() => restoreWithheldMedia(saved, storedBody, hidden)).toThrow(
      'This article body names an image it does not hold'
    );
  });

  it("🔴 restores the stored link's href, not text from another attribute", () => {
    const href = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${HIDDEN}/original=true`;
    const tricky = `<p><a data-id="x href=javascript:alert(1)" href="${href}">it</a></p>`;
    const restored = restoreWithheldMedia(
      '<p><a data-withheld-href="0">it</a></p>',
      tricky,
      hidden
    );
    expect(restored).toBe(`<p><a href="${href}">it</a></p>`);
  });
});
