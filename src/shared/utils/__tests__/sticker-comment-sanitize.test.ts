import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

// The comment schemas override `allowedTags` to a list that excludes `img`, so a
// sticker rides through as `<span data-type="sticker" data-id>` — the same
// mechanism @mentions use. If someone "simplifies" the node to an <img>, or
// trims DEFAULT_ALLOWED_ATTRIBUTES, stickers silently vanish from every comment
// at submit time with no error. These pin that contract.
const COMMENT_ALLOWED_TAGS = ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'span'];
const sanitizeAsComment = (html: string) =>
  sanitizeHtml(html, { allowedTags: COMMENT_ALLOWED_TAGS });

describe('sticker markup through comment sanitization', () => {
  it('keeps the span and the attributes the renderer needs', () => {
    const clean = sanitizeAsComment('<p><span data-type="sticker" data-id="12"></span></p>');

    expect(clean).toContain('data-type="sticker"');
    expect(clean).toContain('data-id="12"');
  });

  it('keeps the slug label used for alt text and copy/paste', () => {
    const clean = sanitizeAsComment(
      '<p><span data-type="sticker" data-id="12" data-label="party_cat"></span></p>'
    );

    expect(clean).toContain('data-label="party_cat"');
  });

  it('still strips img, which is why stickers are spans', () => {
    const clean = sanitizeAsComment('<p><img src="https://example.com/x.png" /></p>');

    expect(clean).not.toContain('<img');
  });

  it('survives alongside a mention without disturbing it', () => {
    const clean = sanitizeAsComment(
      '<p><span data-type="mention" data-id="1" data-label="bob"></span>' +
        '<span data-type="sticker" data-id="12"></span></p>'
    );

    expect(clean).toContain('data-type="mention"');
    expect(clean).toContain('data-type="sticker"');
  });
});
