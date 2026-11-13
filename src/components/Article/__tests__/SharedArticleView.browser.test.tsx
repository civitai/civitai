import { generateJSON } from '@tiptap/html';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
import '~/styles/globals.css';

/**
 * The shared draft view's body images under the same guard as the article page, for a signed-out
 * link holder whose browsing level is PG only. Levels: PG = 1, R = 4.
 */

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => null,
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

function renderDraft(html: string, contentImages: ReturnType<typeof image>[]) {
  const article = {
    id: 1,
    title: 'Shared draft',
    content: html,
    updatedAt: new Date(),
    user: { id: 10, username: 'author' },
    nsfwLevel: PG,
    contentJson: generateJSON(html, tiptapExtensions),
    contentImages,
    coverImage: undefined,
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
  test('🔴 an R body image is covered for a PG reader, and its src is not in the page', async () => {
    const { container } = await renderDraft(`${media(R_UUID)}${media(PG_UUID)}`, [
      image(501, R_UUID, R),
      image(502, PG_UUID, PG),
    ]);

    await expect.element(page.getByText('This image is rated')).toBeVisible();
    expect(imgWithSrc(container, R_UUID)).toHaveLength(0);
    // Control: the PG image beside it renders, so an absent src is the guard, not a broken render.
    await expect.poll(() => imgWithSrc(container, PG_UUID)).toHaveLength(1);
  });
});
