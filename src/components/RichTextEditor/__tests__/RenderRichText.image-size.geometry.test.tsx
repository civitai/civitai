import { beforeEach, describe, expect, it, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import type * as CurrentUser from '~/hooks/useCurrentUser';
import { box, renderAtViewport } from '../../../../test/geometry-setup';
import articleBodyClasses from '~/components/RichTextEditor/ArticleBody.module.scss';
import type { BodyImageGuard } from '~/components/RichTextEditor/GuardedBodyMedia';
import { RenderRichText } from '~/components/RichTextEditor/RenderRichText';

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
    ['left', 'right edge of the image', (img: DOMRect, col: DOMRect) => img.left - col.left],
    ['right', 'right edge of the column', (img: DOMRect, col: DOMRect) => col.right - img.right],
  ])('aligns a sized image %s', async (align, _label, gap) => {
    const [img] = await renderArticle([media(await imageUrl(1600, 900), '40', align)]);
    expect(gap(box(img), columnBox())).toBeCloseTo(0, 0);
  });

  it.each([
    ['float-left', (img: DOMRect, char: DOMRect) => char.left >= img.right],
    ['float-right', (img: DOMRect, char: DOMRect) => char.right <= img.left],
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
