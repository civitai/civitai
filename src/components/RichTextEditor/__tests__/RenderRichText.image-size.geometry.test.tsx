import { generateJSON } from '@tiptap/html';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import type * as CurrentUser from '~/hooks/useCurrentUser';
import { box, renderAtViewport } from '../../../../test/geometry-setup';
import articleBodyClasses from '~/components/RichTextEditor/ArticleBody.module.scss';
import type { BodyImageGuard } from '~/components/RichTextEditor/GuardedBodyMedia';
import { RenderRichText } from '~/components/RichTextEditor/RenderRichText';
import editorClasses from '~/components/RichTextEditor/RichTextEditorComponent.module.scss';
import { SizedImageEditNode } from '~/components/RichTextEditor/SizedImageEditNode';
import { EdgeMediaEditNode } from '~/components/TipTap/EdgeMediaNode';
import { tiptapExtensions } from '~/shared/tiptap/extensions';

// The guard reads the viewer; a signed-out one is enough to size the media.
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => null,
}));

const DESKTOP = { width: 1280, height: 800 } as const;
const PHONE = { width: 375, height: 800 } as const;
const COLUMN = 848;

// A blob: URL passes through `useEdgeUrl` untouched, so the image loads with exactly these
// natural dimensions.
async function imageUrl(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
  return URL.createObjectURL(blob);
}

const media = (url: string, size?: string, align?: string) => ({
  type: 'media',
  attrs: { url, type: 'image', filename: 'x.png', size: size ?? null, align: align ?? null },
});
const inlineImage = (src: string, size?: string, align?: string) => ({
  type: 'paragraph',
  content: [{ type: 'image', attrs: { src, size: size ?? null, align: align ?? null } }],
});
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const heading = (text: string) => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text }],
});
const WORDS = 'Text that wraps beside a floated image. '.repeat(12);

/** The box of the first character of the element containing `text`. */
function firstCharBox(text: string) {
  const el = [...document.querySelectorAll('p, h2')].find((e) => e.textContent?.startsWith(text));
  const node = el?.firstChild;
  if (!node) throw new Error(`no element starts with ${text}`);
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 1);
  return range.getBoundingClientRect();
}
type Box = ReturnType<typeof box>;
const columnBox = () => box(document.querySelector('[data-column]') as HTMLElement);

// An article page guards every body image; a PG image is shown, inside the guard's box.
let imageGuard: BodyImageGuard | undefined;

async function renderArticle(
  nodes: object[],
  viewport: { width: number; height: number } = DESKTOP,
  column = COLUMN,
  className?: string,
  imageCount = nodes.length
) {
  await renderAtViewport(
    <div data-column style={{ width: column }}>
      <RenderRichText
        content={{ type: 'doc', content: nodes }}
        className={className}
        imageGuard={imageGuard}
      />
    </div>,
    viewport
  );
  const imgs = await expect
    .poll(() => [...document.querySelectorAll('img')])
    .toHaveLength(imageCount)
    .then(() => [...document.querySelectorAll('img')]);
  await Promise.all(imgs.map((img) => img.decode()));
  return imgs;
}

describe.each([
  ['', undefined],
  [' (guarded, as on the article page)', { images: [], nsfwLevel: 1 }],
])('article image sizes%s', (_label, guard) => {
  beforeEach(() => {
    imageGuard = guard;
  });

  it('renders S at a third of the column and Full at the whole column', async () => {
    const wide = await imageUrl(1600, 900);
    const [small, medium, large, full] = await renderArticle([
      media(wide, '33'),
      media(wide, '50'),
      inlineImage(wide, '75'),
      media(wide),
    ]);

    expect(box(small).width).toBeCloseTo(COLUMN * 0.33, 0);
    expect(box(medium).width).toBeCloseTo(COLUMN * 0.5, 0);
    expect(box(large).width).toBeCloseTo(COLUMN * 0.75, 0);
    expect(box(full).width).toBeCloseTo(COLUMN, 0);
  });

  it.each([
    ['', undefined],
    [' with the article-typography flag', articleBodyClasses.articleBody],
  ])('centres a sized image in the column%s', async (_label, className) => {
    const [small] = await renderArticle(
      [media(await imageUrl(1600, 900), '33')],
      DESKTOP,
      COLUMN,
      className
    );
    const host = small.closest('div[style]') as HTMLElement;
    const { left, width } = box(small);
    expect(width).toBeLessThan(COLUMN / 2);
    expect(left - box(host).left).toBeCloseTo((COLUMN - width) / 2, 0);
  });

  it('never shows an image wider than its natural size', async () => {
    const tiny = await imageUrl(200, 150);
    const [sized, unsized] = await renderArticle([media(tiny, '75'), inlineImage(tiny)]);

    expect(box(sized).width).toBe(200);
    expect(box(unsized).width).toBe(200);
  });

  // Product decision: an unsized image keeps the pre-sizing layout (natural size up to the column,
  // start of the line, no screen-height cap). The 80vh cap and centring shrank existing stories;
  // do not bring them back for unsized images.
  it('shows an unsized tall portrait at its natural size, from the start of the column', async () => {
    const [portrait] = await renderArticle([media(await imageUrl(832, 1216))]);
    const host = portrait.closest('div[style]') as HTMLElement;
    const { width, height, left } = box(portrait);

    expect({ width, height }).toEqual({ width: 832, height: 1216 });
    expect(left).toBe(box(host).left);
  });

  it('leaves an unsized small image at the start of the line', async () => {
    const [unsized] = await renderArticle([inlineImage(await imageUrl(200, 150))]);
    const host = unsized.closest('div[style]') as HTMLElement;
    expect(box(unsized).left).toBe(box(host).left);
  });

  it('renders a dragged width at that share of the column', async () => {
    const wide = await imageUrl(1600, 900);
    const [forty, eightyFive] = await renderArticle([media(wide, '40'), inlineImage(wide, '85')]);

    expect(box(forty).width).toBeCloseTo(COLUMN * 0.4, 0);
    expect(box(eightyFive).width).toBeCloseTo(COLUMN * 0.85, 0);
  });

  it.each([
    ['left', (img: Box, col: Box) => img.left - col.left],
    ['right', (img: Box, col: Box) => col.right - img.right],
  ])('aligns a sized image %s, flush with that edge of the column', async (align, gap) => {
    const [img] = await renderArticle([media(await imageUrl(1600, 900), '40', align)]);
    expect(gap(box(img), columnBox())).toBeCloseTo(0, 0);
  });

  it.each([
    ['float-left', (img: Box, char: Box) => char.left >= img.right],
    ['float-right', (img: Box, char: Box) => char.right <= img.left],
  ])('%s wraps the following text beside the image', async (align, beside) => {
    const [img] = await renderArticle(
      [media(await imageUrl(1600, 900), '40', align), paragraph(WORDS)],
      DESKTOP,
      COLUMN,
      undefined,
      1
    );
    const char = firstCharBox('Text that wraps');

    expect(box(img).width).toBeCloseTo(COLUMN * 0.4, 0);
    expect(beside(box(img), char)).toBe(true);
    expect(char.top).toBeLessThan(box(img).bottom);
  });

  it('in the article body, starts a floated image level with the text beside it', async () => {
    const [img] = await renderArticle(
      [media(await imageUrl(1600, 900), '40', 'float-left'), paragraph(WORDS)],
      DESKTOP,
      COLUMN,
      articleBodyClasses.articleBody,
      1
    );
    expect(box(img).top - firstCharBox('Text that wraps').top).toBeLessThan(12);
  });

  it('starts a heading below a floated image', async () => {
    const [img] = await renderArticle(
      [media(await imageUrl(1600, 900), '40', 'float-left'), paragraph('Short.'), heading('Next')],
      DESKTOP,
      COLUMN,
      undefined,
      1
    );
    expect(firstCharBox('Next').top).toBeGreaterThanOrEqual(box(img).bottom);
  });

  it('on a phone, stacks a float as a block above the text, up to the full column', async () => {
    const column = PHONE.width - 32;
    // Small enough that a float would leave room for text beside it.
    const [narrow, wide] = await renderArticle(
      [
        media(await imageUrl(200, 150), '40', 'float-left'),
        paragraph(WORDS),
        media(await imageUrl(1600, 900), '40', 'float-right'),
      ],
      PHONE,
      column,
      undefined,
      2
    );

    expect(box(narrow).width).toBe(200);
    expect(box(wide).width).toBeCloseTo(column, 0);
    expect(firstCharBox('Text that wraps').top).toBeGreaterThanOrEqual(box(narrow).bottom);
  });

  it('on a phone, shows S and M at 60% of the column and keeps L as set', async () => {
    const column = PHONE.width - 32;
    const wide = await imageUrl(1600, 900);
    const [small, medium, large] = await renderArticle(
      [media(wide, '33'), media(wide, '50'), media(wide, '75')],
      PHONE,
      column
    );

    expect(box(small).width).toBeCloseTo(column * 0.6, 0);
    expect(box(medium).width).toBeCloseTo(column * 0.6, 0);
    expect(box(large).width).toBeCloseTo(column * 0.75, 0);
  });
});

type Image = (url: string, align: string) => string;
// The article stores uploads as <edge-media>. In the editor a blob: media url starts an upload,
// so the editor gets the plain <img> node: it sits in the same frame with the same layout.
const edgeMediaTag: Image = (url, align) =>
  `<edge-media url="${url}" type="image" filename="x.png" data-width="40" data-align="${align}"></edge-media>`;
const imgTag: Image = (url, align) => `<img src="${url}" data-width="40" data-align="${align}">`;
const CAPTION = 'Caption beside the image.';
const NEXT = 'Next paragraph after the image.';

// The article editor's image nodes and image-layout class (RichTextEditorComponent, imageSize).
function ArticleEditor({ html }: { html: string }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false }),
      EdgeMediaEditNode.configure({ accepts: ['image', 'video'], inline: true, resizable: true }),
      SizedImageEditNode.configure({ inline: true, resizable: true }),
    ],
    content: html,
    immediatelyRender: true,
  });
  return (
    <div className={editorClasses.sizedImages}>
      <EditorContent editor={editor} />
    </div>
  );
}

// The article page renders the doc the server parses from the stored HTML (articleContentJson),
// which lifts a block image out of its paragraph and leaves an empty one in front of it.
function SavedArticle({ html, typography }: { html: string; typography: boolean }) {
  return (
    <RenderRichText
      content={generateJSON(html, tiptapExtensions)}
      className={typography ? articleBodyClasses.articleBody : undefined}
      imageGuard={{ images: [], nsfwLevel: 1 }}
    />
  );
}

const FLOAT_VIEWS = [
  ['the editor', imgTag, (html: string) => <ArticleEditor html={html} />],
  ['the article', edgeMediaTag, (html: string) => <SavedArticle html={html} typography={false} />],
  [
    'the article with article-typography',
    edgeMediaTag,
    (html: string) => <SavedArticle html={html} typography />,
  ],
] as const;

async function renderDoc(view: (html: string) => React.ReactElement, html: string, images = 1) {
  await renderAtViewport(<div style={{ width: COLUMN }}>{view(html)}</div>, DESKTOP);
  return expect
    .poll(() => [...document.querySelectorAll('img')].filter((img) => img.naturalWidth > 0))
    .toHaveLength(images)
    .then(() => [...document.querySelectorAll('img')].map(box));
}

/** The box of the first character of `text`. In the editor a caption shares its paragraph with
 * the image's node view, so this finds the text node, not the paragraph. */
function firstTextChar(text: string) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && !node.textContent?.startsWith(text)) node = walker.nextNode();
  if (!node) throw new Error(`no text starts with ${text}`);
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 1);
  return range.getBoundingClientRect();
}

describe.each(FLOAT_VIEWS)('a floated article image in %s', (_label, image, view) => {
  // Product decision (hq:article_editor_text_a50v): a blank line ends the wrap, in the editor and
  // on the article alike. Without it authors stacked blank lines until the text cleared the image
  // in the editor, and the article, where a blank line is shorter, still wrapped it.
  it.each([
    ['float-left', 'paragraph', `<p>${NEXT}</p>`],
    ['float-right', 'paragraph', `<p>${NEXT}</p>`],
    ['float-left', 'list', `<ul><li><p>${NEXT}</p></li></ul>`],
  ])('%s: a blank line puts the next %s below the image', async (align, _block, next) => {
    const tall = await imageUrl(600, 900);
    const [img] = await renderDoc(view, `<p>${image(tall, align)}${CAPTION}</p><p></p>${next}`);

    expect(firstTextChar(NEXT).top).toBeGreaterThanOrEqual(img.bottom);
  });

  // Top-level blank lines only: inside a spoiler block the article can't clear the outer float,
  // so the editor must not either. A blockquote stands in for any nested block.
  it('a blank line inside a nested block leaves the wrap alone', async () => {
    const tall = await imageUrl(600, 900);
    const [img] = await renderDoc(
      view,
      `<p>${image(
        tall,
        'float-left'
      )}${CAPTION}</p><blockquote><p>Quoted.</p><p></p><p>${NEXT}</p></blockquote>`
    );

    expect(firstTextChar(NEXT).top).toBeLessThan(img.bottom);
  });

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
      const tall = await imageUrl(600, 900);
      const [img] = await renderDoc(view, `<p>${image(tall, align)}${CAPTION}</p><p>${NEXT}</p>`);

      for (const text of [CAPTION, NEXT]) {
        expect(beside(img, firstTextChar(text))).toBe(true);
        expect(firstTextChar(text).top).toBeLessThan(img.bottom);
      }
    }
  );

  // The article's parser leaves an empty paragraph in front of each image it lifts out of a
  // paragraph, so a blank line here must not be taken for one the author typed.
  it.each([
    ['in one paragraph', (a: string, b: string) => `<p>${a}${b}</p>`],
    ['in consecutive paragraphs', (a: string, b: string) => `<p>${a}</p><p>${b}</p>`],
  ])('two floated images %s stay side by side', async (_shape, shape) => {
    const a = image(await imageUrl(600, 400), 'float-left');
    const b = image(await imageUrl(600, 400), 'float-left');
    const [first, second] = await renderDoc(view, `${shape(a, b)}<p>${NEXT}</p>`, 2);

    // Beside, not level: their tops differ by a few pixels already (an image row is
    // hq:articles_side_side_qxm1), so this pins only that the second is not pushed below.
    expect(second.left).toBeGreaterThanOrEqual(first.right);
    expect(second.top).toBeLessThan(first.bottom);
  });

  it('an image aligned left, not floated, keeps the text below it', async () => {
    const [img] = await renderDoc(
      view,
      `<p>${image(await imageUrl(600, 400), 'left')}</p><p>${NEXT}</p>`
    );

    expect(firstTextChar(NEXT).top).toBeGreaterThanOrEqual(img.bottom);
  });
});
