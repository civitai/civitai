import { generateHTML, generateJSON } from '@tiptap/html/server';
import { describe, expect, it } from 'vitest';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { articleContentJson } from '~/server/utils/article-content-json';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

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

  // The article page renders contentJson, not the stored HTML, so alignment that the sanitizer
  // keeps is still lost here unless the shared extensions carry it.
  it.each(['p', 'h2'])('keeps text-align on <%s> through generateJSON and back', (tag) => {
    const doc = generateJSON(`<${tag} style="text-align:center">hi</${tag}>`, tiptapExtensions);

    expect(doc.content?.[0].attrs?.textAlign).toBe('center');
    expect(generateHTML(doc, tiptapExtensions)).toContain('text-align: center');
  });

  it('keeps an unaligned block unstyled', () => {
    const doc = generateJSON('<p>hi</p>', tiptapExtensions);

    expect(generateHTML(doc, tiptapExtensions)).not.toContain('text-align');
  });

  it('keeps a centered paragraph through the save sanitizer, generateJSON and back', () => {
    const saved = sanitizeHtml('<p style="text-align: center; position: fixed">hi</p>');
    // The article service's own entry point, so a later step on that path cannot drop the alignment.
    const html = generateHTML(articleContentJson(saved), tiptapExtensions);

    expect(html).toContain('text-align: center');
    expect(html).not.toContain('position');
  });
});
