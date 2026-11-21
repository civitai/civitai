import { generateJSON } from '@tiptap/html';
import { describe, expect, it, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { box, renderAtViewport } from '../../../../test/geometry-setup';
import type * as CfImages from '~/client-utils/cf-images-utils';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';
import articleBodyClasses from '~/components/RichTextEditor/ArticleBody.module.scss';
import { tiptapExtensions } from '~/shared/tiptap/extensions';

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy({}) };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => null,
}));
// A data: URL as the media url loads as-is, at exactly the size drawn; a blob: one would start an
// upload in the editor.
vi.mock('~/client-utils/cf-images-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof CfImages>()),
  useEdgeUrl: (src: string) => ({ url: src, srcSet: undefined, type: 'image' }),
}));
vi.mock('~/hooks/useCFImageUpload', () => ({ useCFImageUpload: () => ({ uploadToCF: vi.fn() }) }));

const { RichTextEditor } = await import('~/components/RichTextEditor/RichTextEditorComponent');
const { RenderRichText } = await import('~/components/RichTextEditor/RenderRichText');

const DESKTOP = { width: 1280, height: 800 } as const;
const COLUMN = 848;

function imageUrl(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.toDataURL('image/png');
}

const media = (url: string, align: string) =>
  `<edge-media url="${url}" type="image" filename="x.png" data-width="40" data-align="${align}"></edge-media>`;
const CAPTION = 'Caption beside the image.';
const NEXT = 'Next paragraph after the image.';

// The article editor's controls, so the editor is the one authors use (ArticleUpsertForm).
function Editor({ html }: { html: string }) {
  return (
    <RichTextEditor
      value={html}
      editorSize="xl"
      includeControls={['heading', 'formatting', 'list', 'link', 'media', 'video', 'imageSize']}
    />
  );
}

// The article page renders the doc the server parses from the stored HTML (articleContentJson),
// which lifts a block image out of its paragraph and leaves an empty one in front of it.
function Saved({ html, typography }: { html: string; typography: boolean }) {
  return (
    <RenderRichText
      content={generateJSON(html, tiptapExtensions)}
      className={typography ? articleBodyClasses.articleBody : undefined}
      imageGuard={{ images: [], nsfwLevel: 1 }}
    />
  );
}

const VIEWS = [
  ['the editor', (html: string) => <Editor html={html} />],
  ['the article', (html: string) => <Saved html={html} typography={false} />],
  ['the article with article-typography', (html: string) => <Saved html={html} typography />],
] as const;

async function render(view: (html: string) => React.ReactElement, html: string, images = 1) {
  await renderAtViewport(<div style={{ width: COLUMN }}>{view(html)}</div>, DESKTOP);
  return expect
    .poll(() => [...document.querySelectorAll('img')].filter((img) => img.naturalWidth > 0))
    .toHaveLength(images)
    .then(() => [...document.querySelectorAll('img')].map(box));
}

/** The box of the first character of `text`. In the editor a caption shares its paragraph with
 * the image's node view, so this finds the text node, not the paragraph. */
function firstChar(text: string) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && !node.textContent?.startsWith(text)) node = walker.nextNode();
  if (!node) throw new Error(`no text starts with ${text}`);
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 1);
  return range.getBoundingClientRect();
}

describe.each(VIEWS)('a floated article image in %s', (_label, view) => {
  // Product decision (hq:article_editor_text_a50v): a blank line ends the wrap, in the editor and
  // on the article alike. Without it authors stacked blank lines until the text cleared the image
  // in the editor, and the article, where a blank line is shorter, still wrapped it.
  it.each(['float-left', 'float-right'])(
    '%s: a blank line puts the next paragraph below the image',
    async (align) => {
      const tall = imageUrl(600, 900);
      const [img] = await render(
        view,
        `<p>${media(tall, align)}${CAPTION}</p><p></p><p>${NEXT}</p>`
      );

      expect(firstChar(NEXT).top).toBeGreaterThanOrEqual(img.bottom);
    }
  );

  it.each([
    [
      'float-left',
      (img: DOMRect | ReturnType<typeof box>, char: DOMRect) => char.left >= img.right,
    ],
    [
      'float-right',
      (img: DOMRect | ReturnType<typeof box>, char: DOMRect) => char.right <= img.left,
    ],
  ])(
    '%s: the caption and, with no blank line, the next paragraph wrap beside it',
    async (align, beside) => {
      const tall = imageUrl(600, 900);
      const [img] = await render(view, `<p>${media(tall, align)}${CAPTION}</p><p>${NEXT}</p>`);

      for (const text of [CAPTION, NEXT]) {
        expect(beside(img, firstChar(text))).toBe(true);
        expect(firstChar(text).top).toBeLessThan(img.bottom);
      }
    }
  );

  // The article's parser leaves an empty paragraph in front of each image it lifts out of a
  // paragraph, so a blank line here must not be taken for one the author typed.
  it.each([
    ['in one paragraph', (a: string, b: string) => `<p>${a}${b}</p>`],
    ['in consecutive paragraphs', (a: string, b: string) => `<p>${a}</p><p>${b}</p>`],
  ])('two floated images %s stay side by side', async (_shape, shape) => {
    const url = imageUrl(600, 400);
    const float = media(url, 'float-left');
    const [first, second] = await render(view, `${shape(float, float)}<p>${NEXT}</p>`, 2);

    // Beside, not level: their tops differ by a few pixels already (an image row is
    // hq:articles_side_side_qxm1), so this pins only that the second is not pushed below.
    expect(second.left).toBeGreaterThanOrEqual(first.right);
    expect(second.top).toBeLessThan(first.bottom);
  });

  it('an image aligned left, not floated, keeps the text below it', async () => {
    const [img] = await render(view, `<p>${media(imageUrl(600, 400), 'left')}</p><p>${NEXT}</p>`);

    expect(firstChar(NEXT).top).toBeGreaterThanOrEqual(img.bottom);
  });
});
