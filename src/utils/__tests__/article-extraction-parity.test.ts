/**
 * Parity test for article media extraction.
 *
 * `extractImagesFromArticle` (client, `src/utils/article-helpers.ts`) uses the
 * browser `DOMParser` to walk HTML, while `getContentMedia` (server,
 * `src/server/services/article-content-cleanup.service.ts`) uses
 * `@tiptap/html/server`'s `generateJSON` to walk the tiptap AST. They feed
 * two different consumers — the server persists `ImageConnection` rows, the
 * client renders scan-status UI — so any drift between them would cause the
 * UI and the DB to disagree about which images an article contains.
 *
 * Both consumers treat the output as a set keyed by `url` (see
 * `linkArticleContentImages` in `article.service.ts` and
 * `ArticleUpsertForm.tsx`), so the parity we care about is multiset equality,
 * not array order. We normalize by sort before comparing.
 *
 * Note on environment: we stay in the default `node` vitest environment and
 * polyfill only `DOMParser` via happy-dom, because `@tiptap/html/server`'s
 * `generateJSON` uses its own happy-dom instance internally — switching the
 * whole test environment to happy-dom conflicts with tiptap's internal DOM
 * and breaks `getContentMedia`.
 */

import { Window } from 'happy-dom';
import { beforeAll, describe, expect, it } from 'vitest';

import { getContentMedia } from '~/server/services/article-content-cleanup.service';
import type { ExtractedMedia } from '~/utils/article-helpers';
import { extractImagesFromArticle } from '~/utils/article-helpers';

beforeAll(() => {
  // Polyfill just DOMParser for the client-side extractor. We deliberately do
  // not set `window` / `document` globals because tiptap's server-side HTML
  // parser brings its own happy-dom instance and would be broken by shared
  // globals.
  if (typeof (globalThis as { DOMParser?: unknown }).DOMParser === 'undefined') {
    const win = new Window();
    (globalThis as { DOMParser?: unknown }).DOMParser = win.DOMParser;
  }
});

const UUID_1 = 'f1f87d35-81ca-4c55-a705-5d518f59d2ce';
const UUID_2 = 'a2b3c4d5-6789-0abc-def1-234567890abc';
const UUID_3 = 'c3d4e5f6-7890-1bcd-ef23-456789012345';

const cdnImg = (uuid: string) =>
  `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${uuid}/original=true/img.jpeg`;

const normalize = (media: ExtractedMedia[]): ExtractedMedia[] =>
  [...media].sort((a, b) => {
    if (a.url !== b.url) return a.url < b.url ? -1 : 1;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    const altA = a.alt ?? '';
    const altB = b.alt ?? '';
    if (altA !== altB) return altA < altB ? -1 : 1;
    return 0;
  });

type Fixture = {
  name: string;
  html: string;
  expected: ExtractedMedia[];
};

const fixtures: Fixture[] = [
  {
    name: 'empty string',
    html: '',
    expected: [],
  },
  {
    name: 'whitespace only',
    html: '   \n\t  ',
    expected: [],
  },
  {
    name: 'paragraph with no media',
    html: '<p>Just some text, no images here.</p>',
    expected: [],
  },
  {
    name: 'single img with Cloudflare URL and alt text',
    html: `<p><img src="${cdnImg(UUID_1)}" alt="A cool photo" /></p>`,
    expected: [{ url: UUID_1, type: 'image', alt: 'A cool photo' }],
  },
  {
    name: 'single img with no alt',
    html: `<p><img src="${cdnImg(UUID_1)}" /></p>`,
    expected: [{ url: UUID_1, type: 'image', alt: undefined }],
  },
  {
    name: 'single edge-media image with filename',
    html: `<edge-media url="${UUID_1}" type="image" filename="photo.jpg"></edge-media>`,
    expected: [{ url: UUID_1, type: 'image', alt: 'photo.jpg' }],
  },
  {
    name: 'single edge-media image without filename',
    html: `<edge-media url="${UUID_1}" type="image"></edge-media>`,
    expected: [{ url: UUID_1, type: 'image', alt: undefined }],
  },
  {
    name: 'edge-media video',
    html: `<edge-media url="${UUID_1}" type="video" filename="clip.mp4"></edge-media>`,
    expected: [{ url: UUID_1, type: 'video', alt: 'clip.mp4' }],
  },
  {
    name: 'external img is filtered out',
    html: '<p><img src="https://evil.example.com/photo.jpg" alt="nope" /></p>',
    expected: [],
  },
  {
    name: 'img on non-Cloudflare civitai page url is filtered out',
    // civitai.com is an allowed host, but the path doesn't contain a UUID
    html: '<p><img src="https://civitai.com/images/12345" alt="not a uuid" /></p>',
    expected: [],
  },
  {
    name: 'mixed images and edge-media interleaved',
    html: [
      '<p>Intro</p>',
      `<edge-media url="${UUID_1}" type="image" filename="first.jpg"></edge-media>`,
      '<p>Middle</p>',
      `<p><img src="${cdnImg(UUID_2)}" alt="second" /></p>`,
      '<p>After</p>',
      `<edge-media url="${UUID_3}" type="video" filename="third.mp4"></edge-media>`,
    ].join('\n'),
    expected: [
      { url: UUID_1, type: 'image', alt: 'first.jpg' },
      { url: UUID_2, type: 'image', alt: 'second' },
      { url: UUID_3, type: 'video', alt: 'third.mp4' },
    ],
  },
  {
    name: 'edge-media nested inside a blockquote',
    html: [
      '<blockquote>',
      '  <p>Quote:</p>',
      `  <edge-media url="${UUID_1}" type="image" filename="nested.jpg"></edge-media>`,
      '</blockquote>',
    ].join('\n'),
    expected: [{ url: UUID_1, type: 'image', alt: 'nested.jpg' }],
  },
  {
    name: 'img nested inside a list item',
    html: [
      '<ul>',
      '  <li>Item one</li>',
      `  <li><img src="${cdnImg(UUID_1)}" alt="in list" /></li>`,
      '</ul>',
    ].join('\n'),
    expected: [{ url: UUID_1, type: 'image', alt: 'in list' }],
  },
  {
    name: 'duplicate edge-media entries are preserved',
    html: [
      `<edge-media url="${UUID_1}" type="image" filename="dup.jpg"></edge-media>`,
      `<edge-media url="${UUID_1}" type="image" filename="dup.jpg"></edge-media>`,
    ].join('\n'),
    expected: [
      { url: UUID_1, type: 'image', alt: 'dup.jpg' },
      { url: UUID_1, type: 'image', alt: 'dup.jpg' },
    ],
  },
  {
    name: 'mixed valid and invalid img sources',
    html: [
      '<p>',
      '  <img src="https://evil.example.com/nope.jpg" />',
      `  <img src="${cdnImg(UUID_1)}" alt="keeper" />`,
      '  <img src="not-a-url-at-all" />',
      '</p>',
    ].join('\n'),
    expected: [{ url: UUID_1, type: 'image', alt: 'keeper' }],
  },
  {
    name: 'multiple edge-media and imgs in the same paragraph',
    html: [
      `<edge-media url="${UUID_1}" type="image" filename="a.jpg"></edge-media>`,
      `<p><img src="${cdnImg(UUID_2)}" alt="b" /></p>`,
      `<edge-media url="${UUID_3}" type="video" filename="c.mp4"></edge-media>`,
    ].join('\n'),
    expected: [
      { url: UUID_1, type: 'image', alt: 'a.jpg' },
      { url: UUID_2, type: 'image', alt: 'b' },
      { url: UUID_3, type: 'video', alt: 'c.mp4' },
    ],
  },
];

describe('article media extraction — client/server parity', () => {
  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      it('server getContentMedia matches expected', () => {
        expect(normalize(getContentMedia(fixture.html))).toEqual(normalize(fixture.expected));
      });

      it('client extractImagesFromArticle matches expected', () => {
        expect(normalize(extractImagesFromArticle(fixture.html))).toEqual(
          normalize(fixture.expected)
        );
      });

      it('server and client produce equivalent media sets', () => {
        const serverOutput = normalize(getContentMedia(fixture.html));
        const clientOutput = normalize(extractImagesFromArticle(fixture.html));
        expect(serverOutput).toEqual(clientOutput);
      });
    });
  }
});
