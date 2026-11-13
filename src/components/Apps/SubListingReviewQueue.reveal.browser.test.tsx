import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';
import '~/styles/globals.css';

/**
 * The `/apps/review` Sub-listings tab holds each item image behind the moderator click-to-reveal
 * (`ReviewMediaReveal`, the real `ImageGuard2` underneath) on a host that cannot show mature
 * content, judged by THAT image's own level — the live image and a proposed replacement are
 * judged separately.
 *
 * Levels: PG = 1, PG-13 = 2, R = 4, XXX = 16. Image ids 401 / 402 / 403, distinct from them.
 */

const m = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  flags: { canViewNsfw: false },
}));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, isModerator: true }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, canViewNsfw: m.flags.canViewNsfw }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, canViewNsfw: m.flags.canViewNsfw }),
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: () => false,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      {
        'appListings.listSubListingQueue': {
          useQuery: () => ({
            data: { items: m.rows },
            isLoading: false,
            error: null,
            refetch: vi.fn(),
          }),
        },
        'appListings.moderateSubListing': {
          useMutation: () => ({ isPending: false, variables: undefined, mutate: vi.fn() }),
        },
      },
      {
        useUtils: () => ({
          appListings: {
            listSubListingQueue: { invalidate: () => Promise.resolve() },
            countSubListingQueue: { invalidate: () => Promise.resolve() },
          },
        }),
      }
    ),
  };
});

const { SubListingReviewQueue } = await import('./SubListingReviewQueue');

const PG = 1;
const PG13 = 2;
const R = 4;
const XXX = 16;

const live = {
  title: 'Neon Portraits',
  tagline: null,
  imageId: null as number | null,
  subPath: 'g/NEON',
  contentRating: null,
  imageUrl: null as string | null,
  imageNsfwLevel: null as number | null,
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'asl_1',
    status: 'pending',
    statusReason: null,
    itemKey: 'neon',
    parent: { id: 'apl_P', slug: 'custom-generators', name: 'Custom Generators' },
    author: { id: 7, username: 'pixelwitch', image: null },
    externalHref: null,
    live,
    pending: null,
    createdAt: new Date(),
    moderatedAt: null,
    version: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

const revealed = (testId: string) =>
  page
    .getByTestId(testId)
    .element()
    .querySelector('[data-revealed]')
    ?.getAttribute('data-revealed');

beforeEach(() => {
  m.rows = [];
  m.flags.canViewNsfw = false;
});

describe('SubListingReviewQueue click-to-reveal', () => {
  test('🔴 on civitai.com an R item image is held back (blurred AND inert) until revealed', async () => {
    m.rows = [row({ live: { ...live, imageId: 401, imageUrl: 'r-key', imageNsfwLevel: R } })];
    renderWithProviders(<SubListingReviewQueue />);
    const reveal = 'sub-listing-image-reveal-asl_1';
    await expect.element(page.getByTestId(reveal)).toBeInTheDocument();
    expect(revealed(reveal)).toBe('false');
    const held = page.getByTestId(reveal).element().querySelector('[data-revealed]');
    expect(held?.hasAttribute('inert')).toBe(true);
    expect((held as HTMLElement).style.filter).toContain('blur');
    // No full-size overlay: it does not fit a 96px thumbnail. And nothing but the image and the
    // icon-only control renders inside the reveal — no stray text.
    expect(page.getByText('This image is rated').query()).toBeNull();
    expect(page.getByTestId(reveal).element().textContent).toBe('');

    // The thumbnail has no larger view, so the reveal is the compact control in its corner —
    // outside the inert subtree, so it is clickable while the image is hidden.
    const toggle = page.getByTestId(`${reveal}-toggle`);
    await expect.element(toggle).toHaveAccessibleName('Show content');
    await userEvent.click(toggle);
    await expect.poll(() => revealed(reveal)).toBe('true');
    expect(
      page.getByTestId(reveal).element().querySelector('[data-revealed]')?.hasAttribute('inert')
    ).toBe(false);

    // The same control hides it again.
    await expect.element(toggle).toHaveAccessibleName('Hide content');
    await userEvent.click(toggle);
    await expect.poll(() => revealed(reveal)).toBe('false');
  });

  test('a PG item image renders as it is, with no reveal', async () => {
    m.rows = [row({ live: { ...live, imageId: 401, imageUrl: 'pg-key', imageNsfwLevel: PG } })];
    renderWithProviders(<SubListingReviewQueue />);
    await expect.element(page.getByText('Neon Portraits')).toBeVisible();
    expect(page.getByTestId('sub-listing-image-reveal-asl_1').query()).toBeNull();
    expect(page.getByTestId('sub-listing-row').element().querySelector('img')).not.toBeNull();
  });

  test('🔴 a staged image change judges the live and the proposed image by their own levels', async () => {
    m.rows = [
      row({
        status: 'approved',
        live: { ...live, imageId: 402, imageUrl: 'live-key', imageNsfwLevel: PG13 },
        pending: {
          ...live,
          imageId: 403,
          imageUrl: 'proposed-key',
          imageNsfwLevel: XXX,
          submittedAt: new Date(),
        },
      }),
    ];
    renderWithProviders(<SubListingReviewQueue />);
    await expect.element(page.getByText('Edit waiting for review')).toBeVisible();
    expect(page.getByTestId('sub-listing-diff-imageUrl-proposed').query()).not.toBeNull();
    expect(page.getByTestId('sub-listing-image-reveal-asl_1-live').query()).toBeNull();
    expect(revealed('sub-listing-image-reveal-asl_1-proposed')).toBe('false');
  });

  test('on a host that shows mature content the same R image is not held back', async () => {
    m.flags.canViewNsfw = true;
    m.rows = [row({ live: { ...live, imageId: 401, imageUrl: 'r-key', imageNsfwLevel: R } })];
    renderWithProviders(<SubListingReviewQueue />);
    await expect.element(page.getByText('Neon Portraits')).toBeVisible();
    expect(page.getByTestId('sub-listing-image-reveal-asl_1').query()).toBeNull();
  });
});
