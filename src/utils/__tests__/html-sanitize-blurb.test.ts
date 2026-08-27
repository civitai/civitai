import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

const BLURB = '<div data-type="blurb" data-id="7">text</div>';

describe('blurbs in sanitizeHtml', () => {
  it('a blurb is stripped by default', () => {
    expect(sanitizeHtml(`<p>a</p>${BLURB}`)).not.toContain('data-type="blurb"');
  });

  it('a blurb survives when the surface opts in', () => {
    expect(sanitizeHtml(`<p>a</p>${BLURB}`, { allowBlurbs: true })).toContain('data-type="blurb"');
  });

  // 🔴 `data-id` is the ONLY thing tying a stored blurb back to its row, and every host body goes
  // through this on save. Drop it from `DEFAULT_ALLOWED_ATTRIBUTES.div` and `findBlurbSpans` skips
  // the element, `expandBlurbs` sees plain text, no reference row is ever written and the blurb is
  // frozen — with nothing anywhere reporting it.
  it('🔴 keeps data-id on an opted-in blurb', () => {
    expect(sanitizeHtml(`<p>a</p>${BLURB}`, { allowBlurbs: true })).toContain('data-id="7"');
  });

  it('is matched case-insensitively and ignoring whitespace', () => {
    expect(sanitizeHtml('<div data-type=" BLURB " data-id="7">x</div>')).not.toContain(
      'data-id="7"'
    );
  });

  it('do not disturb mentions', () => {
    const mention = '<span data-type="mention" data-id="3">@x</span>';
    expect(sanitizeHtml(mention)).toContain('data-type="mention"');
  });

  it('keeps the words when it strips a reference', () => {
    const out = sanitizeHtml(`<p>a</p>${BLURB}<p>b</p>`);
    expect(out).toContain('text');
    expect(out).not.toContain('data-id');
  });

  it("a caller's own div transform cannot reinstate the reference", () => {
    const out = sanitizeHtml(BLURB, {
      transformTags: {
        div: (tagName: string, attribs: Record<string, string>) => ({ tagName, attribs }),
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
