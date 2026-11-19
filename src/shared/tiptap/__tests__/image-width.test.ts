import { generateHTML } from '@tiptap/html';
import { describe, expect, it } from 'vitest';
import { generateJSON } from '~/server/utils/tiptap-generate-json';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

// Save to render: the sanitizer on `upsertArticleInput.content`, then the `generateJSON` that
// `getArticleById` runs on each read. Losing `data-width` at either step drops the size silently.
const throughSave = (html: string) =>
  generateJSON(sanitizeHtml(html, { allowBlurbs: true }), tiptapExtensions) as {
    content: { type: string; attrs?: Record<string, unknown>; content?: any[] }[];
  };

const findNode = (doc: ReturnType<typeof throughSave>, type: string): any => {
  const stack: any[] = [...doc.content];
  while (stack.length) {
    const node = stack.shift();
    if (node.type === type) return node;
    if (node.content) stack.push(...node.content);
  }
};

// sanitize-html blanks a value that is off its list rather than dropping the attribute.
// An empty `data-width` matches no CSS rule and parses to no size, so only the value matters.
const storedWidth = (html: string) => /data-width(?:="([^"]*)")?/.exec(html)?.[1] ?? '';

const edgeMedia = (attrs: string) => `<edge-media url="abc" type="image" ${attrs}></edge-media>`;
const img = (attrs: string) => `<p><img src="https://image.civitai.com/x.jpeg" ${attrs}></p>`;

describe('article image size (data-width)', () => {
  it.each(['33', '50', '75', '100'])('keeps data-width="%s" on edge-media and img', (width) => {
    expect(findNode(throughSave(edgeMedia(`data-width="${width}"`)), 'media').attrs.size).toBe(
      width
    );
    expect(findNode(throughSave(img(`data-width="${width}"`)), 'image').attrs.size).toBe(width);
  });

  it.each([
    ['a value off the list', 'data-width="42"'],
    ['CSS smuggled into the value', 'data-width="50;background:url(https://x)"'],
    ['a value with padding', 'data-width=" 50"'],
  ])('drops %s', (_label, attrs) => {
    expect(storedWidth(sanitizeHtml(edgeMedia(attrs)))).toBe('');
    expect(storedWidth(sanitizeHtml(img(attrs)))).toBe('');
    expect(findNode(throughSave(edgeMedia(attrs)), 'media').attrs.size).toBeNull();
    expect(findNode(throughSave(img(attrs)), 'image').attrs.size).toBeNull();
  });

  it('never stores a style on an image', () => {
    const html = sanitizeHtml(img('data-width="50" style="width:2000px"'));
    expect(html).not.toContain('style');
    expect(html).toContain('data-width="50"');
  });

  it('leaves an unsized image with no attribute (old article markup is unchanged)', () => {
    const doc = throughSave(edgeMedia(''));
    expect(findNode(doc, 'media').attrs.size).toBeNull();
    expect(generateHTML(doc, tiptapExtensions)).not.toContain('data-width');
  });

  it('keeps the base node width attribute separate from the size', () => {
    const node = findNode(throughSave(img('width="300" data-width="50"')), 'image');
    expect(String(node.attrs.width)).toBe('300');
    expect(node.attrs.size).toBe('50');
  });
});
