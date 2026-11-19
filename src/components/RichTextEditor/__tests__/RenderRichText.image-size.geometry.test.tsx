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

const media = (url: string, size?: string) => ({
  type: 'media',
  attrs: { url, type: 'image', filename: 'x.png', size: size ?? null },
});
const inlineImage = (src: string, size?: string) => ({
  type: 'paragraph',
  content: [{ type: 'image', attrs: { src, size: size ?? null } }],
});

// An article page guards every body image; a PG image is shown, inside the guard's box.
let imageGuard: BodyImageGuard | undefined;

async function renderArticle(
  nodes: object[],
  viewport: { width: number; height: number } = DESKTOP,
  column = COLUMN,
  className?: string
) {
  await renderAtViewport(
    <div style={{ width: column }}>
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
    .toHaveLength(nodes.length)
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

  it('fits an unsized tall portrait to 80% of the screen height', async () => {
    const [portrait] = await renderArticle([media(await imageUrl(832, 1216))]);
    const { width, height } = box(portrait);

    expect(height).toBeCloseTo(DESKTOP.height * 0.8, 0);
    expect(width / height).toBeCloseTo(832 / 1216, 2);
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
