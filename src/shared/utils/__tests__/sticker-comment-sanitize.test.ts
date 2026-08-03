import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

// The comment schemas override `allowedTags` to a list that excludes `img`, so a
// sticker rides through as `<span data-type="sticker" data-id>` — the same
// mechanism @mentions use. If someone "simplifies" the node to an <img>, or
// trims DEFAULT_ALLOWED_ATTRIBUTES, stickers silently vanish from every comment
// at submit time with no error. These pin that contract.
const COMMENT_ALLOWED_TAGS = ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'span'];
const sanitizeAsComment = (html: string) =>
  sanitizeHtml(html, { allowedTags: COMMENT_ALLOWED_TAGS, allowStickers: true });

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

// Stickers are paid goods, and `span[data-type][data-id]` is in the DEFAULT
// allowlist because mentions need it. Without an explicit opt-in, sticker markup
// pasted into a model description, bounty, review or changelog would be stored
// and rendered as the paid sticker for free. Denied by default; the surfaces
// that charge opt in.
describe('sticker markup is denied unless a surface opts in', () => {
  const stickerSpan = '<p><span data-type="sticker" data-id="12"></span></p>';

  it('strips stickers under the default config', () => {
    expect(sanitizeHtml(stickerSpan)).not.toContain('data-type="sticker"');
  });

  it('strips stickers for a surface that sets its own allowedTags but does not opt in', () => {
    const clean = sanitizeHtml(stickerSpan, { allowedTags: COMMENT_ALLOWED_TAGS });
    expect(clean).not.toContain('data-type="sticker"');
  });

  it('keeps them when the surface opts in', () => {
    expect(sanitizeHtml(stickerSpan, { allowStickers: true })).toContain('data-type="sticker"');
  });

  it("a caller's own exclusiveFilter cannot disable the strip", () => {
    const clean = sanitizeHtml(stickerSpan, { exclusiveFilter: () => false });
    expect(clean).not.toContain('data-type="sticker"');
  });

  it('leaves mentions alone — they ride the same span attributes', () => {
    const mention = '<p><span data-type="mention" data-id="1" data-label="bob">@bob</span></p>';
    expect(sanitizeHtml(mention)).toContain('data-type="mention"');
  });
});
