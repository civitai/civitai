import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

// The shape blurbs are stored in TODAY. `SPAN_BLURB` below is the pre-block shape, still parsed
// and still stripped, and every case is run against both.
const BLURB = '<div data-type="blurb" data-id="7">text</div>';
const SPAN_BLURB = '<span data-type="blurb" data-id="7">text</span>';

describe('blurbs in sanitizeHtml', () => {
  it.each([
    ['div', BLURB],
    ['span', SPAN_BLURB],
  ])('a %s blurb is stripped by default', (_tag, markup) => {
    expect(sanitizeHtml(`<p>a</p>${markup}`)).not.toContain('data-type="blurb"');
  });

  it.each([
    ['div', BLURB],
    ['span', SPAN_BLURB],
  ])('a %s blurb survives when the surface opts in', (_tag, markup) => {
    expect(sanitizeHtml(`<p>a</p>${markup}`, { allowBlurbs: true })).toContain('data-type="blurb"');
  });

  // 🔴 `data-id` is the ONLY thing tying a stored blurb back to its row, and every host body goes
  // through this on save. Drop it from `DEFAULT_ALLOWED_ATTRIBUTES.div` and `findBlurbSpans` skips
  // the element, `expandBlurbs` sees plain text, no reference row is ever written and the blurb is
  // frozen — with nothing anywhere reporting it.
  it('🔴 keeps data-id on an opted-in div blurb', () => {
    expect(sanitizeHtml(`<p>a</p>${BLURB}`, { allowBlurbs: true })).toContain('data-id="7"');
  });

  it.each([
    ['div', '<div data-type=" BLURB " data-id="7">x</div>'],
    ['span', '<span data-type=" BLURB " data-id="7">x</span>'],
  ])('a %s blurb is matched case-insensitively and ignoring whitespace', (_tag, odd) => {
    expect(sanitizeHtml(odd)).not.toContain('data-id="7"');
  });

  it('do not disturb mentions', () => {
    const mention = '<span data-type="mention" data-id="3">@x</span>';
    expect(sanitizeHtml(mention)).toContain('data-type="mention"');
  });

  it.each([
    ['div', BLURB],
    ['span', SPAN_BLURB],
  ])('keeps the words when it strips a %s reference', (_tag, markup) => {
    const out = sanitizeHtml(`<p>a</p>${markup}<p>b</p>`);
    expect(out).toContain('text');
    expect(out).not.toContain('data-id');
  });

  it.each([
    ['div', BLURB, 'div'],
    ['span', SPAN_BLURB, 'span'],
  ])("a caller's own %s transform cannot reinstate the reference", (_label, markup, tag) => {
    const out = sanitizeHtml(markup, {
      transformTags: {
        [tag]: (tagName: string, attribs: Record<string, string>) => ({ tagName, attribs }),
      },
    });
    expect(out).not.toContain('data-type="blurb"');
    expect(out).toContain('text');
  });

  // A youtube embed is the other `div[data-type]` on this allowlist; admitting `data-id` for
  // blurbs must not have made the blurb strip fire on it.
  it('does not disturb a youtube embed div', () => {
    const embed =
      '<div data-type="youtube" data-youtube-video="1"><iframe src="https://www.youtube.com/embed/x"></iframe></div>';
    expect(sanitizeHtml(embed)).toContain('data-type="youtube"');
  });
});
