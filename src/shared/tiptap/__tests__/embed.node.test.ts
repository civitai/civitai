import { describe, expect, it } from 'vitest';
import { generateJSON } from '~/server/utils/tiptap-generate-json';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

// What an article goes through: sanitized on save (article.schema), then turned into contentJson
// on read from the SHARED extension list (getArticleById). A node missing from that list is
// dropped silently, and the article renders without the player.
const save = (html: string) =>
  generateJSON(sanitizeHtml(html, { allowBlurbs: true }), tiptapExtensions) as {
    content: { type: string; attrs?: { src?: string } }[];
  };

describe('EmbedNode through the article save path', () => {
  it('keeps a player embed as an embed node', () => {
    const src = 'https://player.vimeo.com/video/76979871';
    const json = save(
      `<div data-type="embed" data-provider="vimeo"><iframe src="${src}" allow="camera"></iframe></div>`
    );
    expect(json.content.map((n) => [n.type, n.attrs?.src])).toEqual([['embed', src]]);
  });

  it('drops a lookalike player instead of storing it', () => {
    const json = save(
      '<div data-type="embed"><iframe src="https://player.vimeo.com/redirect?to=evil"></iframe></div>'
    );
    expect(json.content.some((n) => n.attrs?.src)).toBe(false);
  });
});
