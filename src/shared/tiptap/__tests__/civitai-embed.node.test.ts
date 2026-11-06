import { generateHTML } from '@tiptap/html';
import { describe, expect, it } from 'vitest';
import { upsertArticleInput } from '~/server/schema/article.schema';
import { generateJSON } from '~/server/utils/tiptap-generate-json';
import { CIVITAI_EMBED_PASTE_URL } from '~/shared/tiptap/civitai-embed.node';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { collectCivitaiEmbedIds, parseCivitaiEmbedUrl } from '~/shared/tiptap/civitai-embed.utils';

const items = [
  { type: 'model', id: 11 },
  { type: 'model', id: 12, versionId: 99 },
  { type: 'image', id: 13 },
];
const doc = (attrs: unknown) => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
    { type: 'civitaiEmbed', attrs },
  ],
});

/** What an article save does to the editor's HTML: the schema's sanitizer, then the server parse. */
function save(html: string) {
  const content = upsertArticleInput.shape.content.parse(html);
  return generateJSON(content, tiptapExtensions);
}
const embedOf = (json: any) => json.content.find((n: any) => n.type === 'civitaiEmbed');

describe('civitaiEmbed node through an article save', () => {
  it('keeps a set of three cards, types, ids and version intact', () => {
    const html = generateHTML(doc({ items }), tiptapExtensions);
    expect(embedOf(save(html))?.attrs.items).toEqual(items);
  });

  it('stores plain links a surface without the node can still follow', () => {
    const html = generateHTML(doc({ items }), tiptapExtensions);
    expect(html).toContain('href="/models/12?modelVersionId=99"');
    expect(html).toContain('href="/images/13"');
  });

  it('rebuilds the href from the ids, never from the stored link', () => {
    const forged =
      '<div data-type="civitaiEmbed"><a href="https://evil.example/x" data-entity="model" data-id="5">x</a></div>';
    const out = generateHTML(save(forged) as any, tiptapExtensions);
    expect(out).toContain('href="/models/5"');
    expect(out).not.toContain('evil.example');
  });

  it('drops entries that are not a known type with positive integer ids', () => {
    const junk =
      '<div data-type="civitaiEmbed">' +
      '<a href="/u" data-entity="user" data-id="1">a</a>' +
      '<a href="/m" data-entity="model" data-id="-3">b</a>' +
      '<a href="/i" data-entity="image" data-id="1e3">c</a>' +
      '<a href="/i" data-entity="image" data-id="8">d</a>' +
      '</div>';
    expect(embedOf(save(junk))?.attrs.items).toEqual([{ type: 'image', id: 8 }]);
  });
});

describe('parseCivitaiEmbedUrl', () => {
  it.each([
    ['https://civitai.com/models/123/some-slug', { type: 'model', id: 123 }],
    [
      'https://civitai.red/models/123?modelVersionId=456',
      { type: 'model', id: 123, versionId: 456 },
    ],
    ['https://civitai.com/images/77', { type: 'image', id: 77 }],
  ])('%s', (url, expected) => expect(parseCivitaiEmbedUrl(url)).toEqual(expected));

  it.each([
    'https://example.com/models/1',
    'https://image.civitai.com/images/1',
    'civitai.com/models/1',
    'https://civitai.com/images',
    'https://civitai.com/articles/5',
  ])('rejects %s', (url) => expect(parseCivitaiEmbedUrl(url)).toBeNull());
});

describe('the paste rule', () => {
  // A paste the regex takes but the parser refuses would insert an empty card.
  it.each([
    'https://civitai.com/models/123',
    'https://www.civitai.red/models/5?modelVersionId=6',
    'https://civitai.com/models/123/slug#reviews',
    'https://civitai.com/images/77/',
    'https://civitai.com/images/77?postId=1',
    'https://civitai.com/models/abc',
    'https://image.civitai.com/images/1',
    'https://civitai.com/user/someone',
  ])('only claims what it can parse: %s', (url) => {
    const claimed = new RegExp(CIVITAI_EMBED_PASTE_URL.source).test(url);
    if (claimed) expect(parseCivitaiEmbedUrl(url)).not.toBeNull();
  });

  it('claims a plain model and image link', () => {
    const re = new RegExp(CIVITAI_EMBED_PASTE_URL.source);
    expect(re.test('https://civitai.com/models/123')).toBe(true);
    expect(re.test('https://civitai.com/images/77')).toBe(true);
  });
});

describe('collectCivitaiEmbedIds', () => {
  it('dedupes ids per type across blocks', () => {
    const twoBlocks = {
      type: 'doc',
      content: [
        { type: 'civitaiEmbed', attrs: { items } },
        { type: 'civitaiEmbed', attrs: { items: [{ type: 'model', id: 11 }] } },
      ],
    };
    expect(collectCivitaiEmbedIds(twoBlocks)).toEqual({ modelIds: [11, 12], imageIds: [13] });
  });
});
