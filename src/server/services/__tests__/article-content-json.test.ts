import { generateJSON } from '@tiptap/html/server';
import { describe, expect, it } from 'vitest';
import { getContentMedia } from '~/server/services/article-content-cleanup.service';
import { tiptapExtensions } from '~/shared/tiptap/extensions';

// `upsertArticleInput.content` runs through sanitize-html, which only strips markup — a JSON
// body carries no tags and survives byte-identical. So anything here is storable in
// `Article.content` by any author and reaches the read path verbatim.
const CRAFTED = {
  'a node type the renderer has no schema entry for':
    '{"type":"doc","content":[{"type":"sticker","attrs":{"id":"1"}}]}',
  'a mark type the renderer has no schema entry for':
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hi","marks":[{"type":"sparkle"}]}]}]}',
  'a text node carrying no text':
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text"}]}]}',
  'malformed JSON': '{oops',
};

type Doc = { type?: string; text?: string; content?: Doc[] };

function nodeTypes(node: Doc): string[] {
  return [node.type, ...(node.content ?? []).flatMap(nodeTypes)].filter((t): t is string => !!t);
}

function textOf(node: Doc): string {
  return (node.text ?? '') + (node.content ?? []).map(textOf).join('');
}

describe('article content is interpreted as HTML, never as JSON', () => {
  for (const [description, content] of Object.entries(CRAFTED)) {
    it(`treats ${description} as literal text`, () => {
      const doc = generateJSON(content, tiptapExtensions) as Doc;

      expect(doc.type).toBe('doc');
      // The payload is shown, not executed — no node the renderer's schema lacks.
      expect(nodeTypes(doc)).not.toContain('sticker');
      expect(textOf(doc)).toContain(content.slice(0, 20));
    });
  }

  it('keeps real HTML working', () => {
    const doc = generateJSON('<p>hello <strong>world</strong></p>', tiptapExtensions);

    expect(nodeTypes(doc)).toContain('paragraph');
  });
});

describe('getContentMedia', () => {
  it('extracts media from HTML content', () => {
    const media = getContentMedia(
      '<edge-media url="7ac0a1b8-0000-4000-8000-000000000000" type="image"></edge-media>'
    );

    expect(media).toEqual([
      { url: '7ac0a1b8-0000-4000-8000-000000000000', type: 'image', alt: undefined },
    ]);
  });

  it('ignores media declared in a crafted JSON body', () => {
    const media = getContentMedia(
      '{"type":"doc","content":[{"type":"media","attrs":{"url":"7ac0a1b8-0000-4000-8000-000000000000","type":"image"}}]}'
    );

    expect(media).toEqual([]);
  });
});
