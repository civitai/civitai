import { generateJSON } from '@tiptap/html';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
import '~/styles/globals.css';

/**
 * The shared draft view's body images under the same guard as the article page, for a link holder
 * whose browsing level is PG only. Levels: PG = 1, R = 4. A signed-out reader only ever reaches a
 * PG draft's body (`Gated` sends them to log in otherwise), so a mature draft is read signed in.
 */

const viewer = vi.hoisted(() => ({ current: null as { id: number; isModerator: boolean } | null }));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => viewer.current,
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canViewNsfw: true }),
  useOptionalFeatureFlags: () => ({ canViewNsfw: true }),
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: () => false,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcModule>()), trpc: makeTrpcProxy() };
});
// The page chrome around the body is not under test.
vi.mock('~/components/Gated/Gated', () => ({
  Gated: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/components/Article/Detail/ArticleDetailComments', () => ({
  ArticleDetailComments: () => null,
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data: unknown[] }) => ({ items: data }),
}));

import { BrowsingModeOverrideCtx } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type { SharedArticle } from '~/server/services/article-share.service';
import { tiptapExtensions } from '~/shared/tiptap/extensions';

const { SharedArticleView } = await import('~/components/Article/SharedArticleView');

const PG = 1;
const R = 4;
const R_UUID = '22222222-2222-4222-8222-222222222222';
const PG_UUID = '33333333-3333-4333-8333-333333333333';

const media = (uuid: string) =>
  `<edge-media url="${uuid}" type="image" filename="${uuid}.png"></edge-media>`;

const image = (id: number, url: string, nsfwLevel: number) => ({
  id,
  url,
  nsfwLevel,
  userId: 10,
  hash: null,
  width: 800,
  height: 1000,
});

function renderDraft(
  html: string,
  contentImages: ReturnType<typeof image>[],
  nsfwLevel = PG,
  images: { coverImage?: ReturnType<typeof image>; bannerImage?: ReturnType<typeof image> } = {}
) {
  const article = {
    id: 1,
    title: 'Shared draft',
    content: html,
    updatedAt: new Date(),
    user: { id: 10, username: 'author' },
    nsfwLevel,
    contentJson: generateJSON(html, tiptapExtensions),
    contentImages,
    coverImage: images.coverImage,
    bannerImage: images.bannerImage,
  } as unknown as SharedArticle;
  return renderWithProviders(
    <BrowsingModeOverrideCtx.Provider value={{ userBrowsingLevel: PG, blurLevels: 28 }}>
      <SharedArticleView article={article} />
    </BrowsingModeOverrideCtx.Provider>
  );
}

const imgWithSrc = (container: HTMLElement, fragment: string) =>
  [...container.querySelectorAll('img')].filter((img) => img.src.includes(fragment));

describe('SharedArticleView body images', () => {
  test('🔴 an R body image is covered for a PG reader and not rendered until Show', async () => {
    const { container } = await renderDraft(`${media(R_UUID)}${media(PG_UUID)}`, [
      image(501, R_UUID, R),
      image(502, PG_UUID, PG),
    ]);

    await expect.element(page.getByText('This image is rated')).toBeVisible();
    expect(imgWithSrc(container, R_UUID)).toHaveLength(0);
    // Control: the PG image beside it renders, so an absent src is the guard, not a broken render.
    await expect.poll(() => imgWithSrc(container, PG_UUID)).toHaveLength(1);
  });

  test('🔴 a body image with no linked row is rated at the draft’s level', async () => {
    // Signed in, not the author or a moderator: the only reader who gets an R draft's body.
    viewer.current = { id: 20, isModerator: false };
    try {
      const { container } = await renderDraft(media(R_UUID), [], R);

      await expect.element(page.getByText('This image is rated')).toBeVisible();
      expect(imgWithSrc(container, R_UUID)).toHaveLength(0);
    } finally {
      viewer.current = null;
    }
  });

  test('a body image with no linked row in a PG draft renders', async () => {
    const { container } = await renderDraft(media(R_UUID), [], PG);

    await expect.poll(() => imgWithSrc(container, R_UUID)).toHaveLength(1);
    expect(page.getByText('This image is rated').query()).toBeNull();
  });
});

describe('SharedArticleView banner', () => {
  const BANNER_UUID = '44444444-4444-4444-8444-444444444444';
  const COVER_UUID = '55555555-5555-4555-8555-555555555555';

  test('🔴 a banner spans the page above the content, with no link or menu', async () => {
    const { container } = await renderDraft('<p>Body</p>', [], PG, {
      bannerImage: image(601, BANNER_UUID, PG),
    });

    const banner = await page.getByTestId('article-banner').element();
    // Outside the narrow reading container, and as wide as the page.
    expect(banner.closest('.mantine-Container-root')).toBeNull();
    expect(Math.round(banner.getBoundingClientRect().width)).toBe(
      document.documentElement.clientWidth
    );
    expect(banner.querySelector('a')).toBeNull();
    await expect.poll(() => imgWithSrc(container, BANNER_UUID).length).toBeGreaterThan(0);
  });

  test('a banner replaces the cover', async () => {
    const { container } = await renderDraft('<p>Body</p>', [], PG, {
      coverImage: image(602, COVER_UUID, PG),
      bannerImage: image(601, BANNER_UUID, PG),
    });

    // Wait for the banner's own image, so an absent cover image is not just one not yet mounted.
    await expect.poll(() => imgWithSrc(container, BANNER_UUID).length).toBeGreaterThan(0);
    expect(imgWithSrc(container, COVER_UUID)).toHaveLength(0);
  });

  test('with no banner, the cover renders as before (control)', async () => {
    const { container } = await renderDraft('<p>Body</p>', [], PG, {
      coverImage: image(602, COVER_UUID, PG),
    });

    await expect.poll(() => imgWithSrc(container, COVER_UUID)).toHaveLength(1);
    expect(page.getByTestId('article-banner').query()).toBeNull();
  });
});

const { ArticleBanner } = await import('~/components/Article/Detail/ArticleBanner');

describe('ArticleBanner', () => {
  const renderBanner = (bare?: boolean) =>
    renderWithProviders(
      <BrowsingModeOverrideCtx.Provider value={{ userBrowsingLevel: PG, blurLevels: 28 }}>
        <ArticleBanner
          image={image(701, '66666666-6666-4666-8666-666666666666', PG) as never}
          articleId={1}
          title="Draft"
          bare={bare}
        />
      </BrowsingModeOverrideCtx.Provider>
    );

  test('🔴 pulls up by the sub nav’s 12px bottom margin so it meets the sub nav', async () => {
    await renderBanner();

    const banner = await page.getByTestId('article-banner').element();
    expect(getComputedStyle(banner).marginTop).toBe('-12px');
  });

  test('links to the image unless bare (control for the bare case)', async () => {
    const { unmount } = await renderBanner();
    expect((await page.getByTestId('article-banner').element()).querySelector('a')).not.toBeNull();
    unmount();

    await renderBanner(true);
    expect((await page.getByTestId('article-banner').element()).querySelector('a')).toBeNull();
  });
});
