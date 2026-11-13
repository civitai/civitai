import { generateJSON } from '@tiptap/html';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
// The real stylesheet, so the overlay's Show button is actionable the way a reader clicks it.
import '~/styles/globals.css';

/**
 * Article body images under the REAL `ImageGuard2`: an image outside the reader's browsing level
 * is covered with the site's own overlay until Show.
 *
 * Levels: R = 4, X = 8, XXX = 16. The reader allows PG–R (7), so X and XXX are blurred (24),
 * which is what BrowsingLevelProvider derives for a reader with "blur mature" off.
 */

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, isModerator: false }),
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

import { BrowsingModeOverrideCtx } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { tiptapExtensions } from '~/shared/tiptap/extensions';

const { RenderRichText } = await import('~/components/RichTextEditor/RenderRichText');

const R = 4;
const X = 8;
const XXX = 16;
const X_UUID = '11111111-1111-4111-8111-111111111111';
const R_UUID = '22222222-2222-4222-8222-222222222222';

const media = (uuid: string, filename: string) =>
  `<edge-media url="${uuid}" type="image" filename="${filename}"></edge-media>`;

const image = (id: number, url: string, nsfwLevel: number) => ({
  id,
  url,
  nsfwLevel,
  userId: 99,
  hash: null,
  width: 800,
  height: 1000,
});

function renderArticle(html: string, images: ReturnType<typeof image>[], nsfwLevel: number) {
  return renderWithProviders(
    <BrowsingModeOverrideCtx.Provider value={{ userBrowsingLevel: 7, blurLevels: X | XXX }}>
      <RenderRichText
        content={generateJSON(html, tiptapExtensions)}
        imageGuard={{ images, nsfwLevel }}
      />
    </BrowsingModeOverrideCtx.Provider>
  );
}

const imgWithSrc = (container: HTMLElement, fragment: string) =>
  [...container.querySelectorAll('img')].filter((img) => img.src.includes(fragment));

describe('RenderRichText article image guard', () => {
  test('🔴 an inline image above the reader’s level is covered, and Show reveals it', async () => {
    const { container } = await renderArticle(media(X_UUID, 'x.png'), [image(501, X_UUID, X)], X);

    await expect.element(page.getByText('This image is rated')).toBeVisible();
    // Covered means the image itself is not in the page, not just blurred over.
    expect(imgWithSrc(container, X_UUID)).toHaveLength(0);

    await page.getByRole('button', { name: 'Show', exact: true }).click();

    await expect.poll(() => imgWithSrc(container, X_UUID)).toHaveLength(1);
    expect(page.getByText('This image is rated').query()).toBeNull();
  });

  test('an inline image within the reader’s level renders with no overlay', async () => {
    const { container } = await renderArticle(media(R_UUID, 'r.png'), [image(502, R_UUID, R)], R);

    await expect.poll(() => imgWithSrc(container, R_UUID)).toHaveLength(1);
    expect(page.getByText('This image is rated').query()).toBeNull();
  });

  test('🔴 an image with no linked Image row is rated at the article’s level', async () => {
    const { container } = await renderArticle(
      `${media(
        R_UUID,
        'r.png'
      )}<p><img src="https://example.com/elsewhere.png" alt="external"></p>`,
      [image(502, R_UUID, R)],
      XXX
    );

    await expect.element(page.getByText('This image is rated')).toBeVisible();
    expect(imgWithSrc(container, 'example.com/elsewhere.png')).toHaveLength(0);
    // The linked R image beside it is unaffected by the article's level.
    await expect.poll(() => imgWithSrc(container, R_UUID)).toHaveLength(1);
  });

  test('an image with no linked Image row shows when the article’s level is within the reader’s', async () => {
    const { container } = await renderArticle(
      '<p><img src="https://example.com/elsewhere.png" alt="external"></p>',
      [],
      R
    );

    await expect.poll(() => imgWithSrc(container, 'example.com/elsewhere.png')).toHaveLength(1);
    expect(page.getByText('This image is rated').query()).toBeNull();
  });

  test('a linked image still unrated (0) is covered for a reader', async () => {
    const { container } = await renderArticle(media(X_UUID, 'x.png'), [image(503, X_UUID, 0)], XXX);

    await expect.element(page.getByText('This image is rated')).toBeVisible();
    expect(imgWithSrc(container, X_UUID)).toHaveLength(0);
  });
});
