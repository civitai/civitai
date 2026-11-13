import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as TrpcModule from '~/utils/trpc';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';

/**
 * The review page's store-listing media with the moderator's per-image facts: an above-SFW image
 * is held behind the click-to-reveal on civitai.com, every image says where it shows, and the
 * civitai.red icon / cover overrides appear as their own tiles labelled civitai.red only.
 *
 * Image ids 301 (PG icon) / 302 (R cover) / 303 (PG red icon) / 304 (XXX red cover).
 */

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, isModerator: true }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, canViewNsfw: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, canViewNsfw: false }),
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: () => false,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcModule>()), trpc: makeTrpcProxy() };
});

import { ReviewListingMedia } from '~/components/Apps/ReviewListingMedia';

const MEDIA = {
  icon: { imageId: 301, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 1 },
  cover: { imageId: 302, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 4 },
  redIcon: { imageId: 303, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 1 },
  redCover: { imageId: 304, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 16 },
};

const revealed = (testId: string) =>
  page
    .getByTestId(testId)
    .element()
    .querySelector('[data-revealed]')
    ?.getAttribute('data-revealed');

describe('ReviewListingMedia with review media', () => {
  test('🔴 an R cover is held behind the reveal on civitai.com; the PG icon is not', async () => {
    renderWithProviders(
      <ReviewListingMedia
        slug="app"
        name="App"
        iconUrl={MEDIA.icon.url}
        coverUrl={MEDIA.cover.url}
        reviewMedia={MEDIA}
        rating="g"
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-cover-app')).toBeInTheDocument();
    expect(revealed('apps-review-listing-cover-reveal-app')).toBe('false');
    expect(page.getByTestId('apps-review-listing-icon-reveal-app').query()).toBeNull();
    await expect.element(page.getByTestId('apps-review-listing-icon-app')).toBeVisible();
  });

  test('🔴 each image says where it shows; the overrides are civitai.red only, whatever their level', async () => {
    renderWithProviders(
      <ReviewListingMedia
        slug="app"
        name="App"
        iconUrl={MEDIA.icon.url}
        coverUrl={MEDIA.cover.url}
        reviewMedia={MEDIA}
        rating="g"
      />
    );
    await expect
      .element(page.getByTestId('apps-review-listing-icon-audience-app'))
      .toHaveTextContent('civitai.com + civitai.red');
    await expect
      .element(page.getByTestId('apps-review-listing-cover-audience-app'))
      .toHaveTextContent('civitai.red only');
    // A PG override is still civitai.red only: civitai.com never reads it.
    await expect
      .element(page.getByTestId('apps-review-listing-red-icon-audience-app'))
      .toHaveTextContent('civitai.red only');
    await expect
      .element(page.getByTestId('apps-review-listing-red-cover-audience-app'))
      .toHaveTextContent('civitai.red only');
    await expect.element(page.getByTestId('apps-review-listing-red-icon-app')).toBeVisible();
    // The XXX override is held behind the reveal like any other mature image.
    expect(revealed('apps-review-listing-red-cover-reveal-app')).toBe('false');
  });

  test('🔴 the lightbox never offers an image the reveal is holding back', async () => {
    // The R cover is held back: its thumbnail opens nothing, so the viewer (a full-size surface
    // the reveal does not wrap) cannot be navigated to it from the SFW icon either.
    renderWithProviders(
      <ReviewListingMedia
        slug="app"
        name="App"
        iconUrl={MEDIA.icon.url}
        coverUrl={MEDIA.cover.url}
        reviewMedia={MEDIA}
        rating="g"
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-icon-button-app')).toBeVisible();
    expect(page.getByTestId('apps-review-listing-cover-button-app').query()).toBeNull();
  });

  test('positive control: a SFW cover keeps its lightbox button', async () => {
    renderWithProviders(
      <ReviewListingMedia
        slug="app"
        name="App"
        iconUrl={MEDIA.icon.url}
        coverUrl={MEDIA.cover.url}
        reviewMedia={{ ...MEDIA, cover: { ...MEDIA.cover, nsfwLevel: 2 } }}
        rating="g"
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-cover-button-app')).toBeVisible();
  });

  test('without review media it renders the two thumbnails exactly as before', async () => {
    renderWithProviders(
      <ReviewListingMedia
        slug="app"
        name="App"
        iconUrl={MEDIA.icon.url}
        coverUrl={MEDIA.cover.url}
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-cover-app')).toBeVisible();
    expect(page.getByTestId('apps-review-listing-cover-reveal-app').query()).toBeNull();
    expect(page.getByTestId('apps-review-listing-red-icon-app').query()).toBeNull();
  });
});
