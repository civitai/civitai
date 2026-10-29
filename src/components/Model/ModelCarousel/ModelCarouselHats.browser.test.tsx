import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// Browser mode only: needs a real layout.

const HAT_URL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M5 0L10 10H0z" fill="#e64980"/></svg>'
  );

const mocks = vi.hoisted(() => {
  const image = (id: number, hatted: boolean) => ({
    id,
    type: 'image',
    url: `img-${id}`,
    name: null,
    width: 800,
    height: 600,
    nsfwLevel: 1,
    hasMeta: false,
    metadata: {},
    reactions: [],
    stats: {},
    user: { id: 9 },
    userId: 9,
    tagIds: [],
    eventDecoration: hatted
      ? { id: 1, data: { type: 'hat', event: 'birthday2026', url: 'HAT' } }
      : null,
  });
  return { images: [image(1, true), image(2, false), image(3, true)] };
});

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  BrowsingLevelProvider: ({ children }: any) => <>{children}</>,
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', () => ({
  BrowsingSettingsAddonsProvider: ({ children }: any) => <>{children}</>,
}));
vi.mock('~/components/HiddenPreferences/HiddenPreferencesProvider', () => ({
  HiddenPreferencesProvider: ({ children }: any) => <>{children}</>,
}));
// The real module pulls the tRPC client and its environment into the browser; only this hook is used.
// eslint-disable-next-line local-rules/no-wholesale-module-mock -- ModelCarousel imports one hook
vi.mock('~/components/Image/image.utils', () => ({
  useQueryImages: () => ({ images: mocks.images, flatData: mocks.images, isLoading: false }),
}));
vi.mock('~/components/Image/ExplainHiddenImages/ExplainHiddenImages', () => ({
  useExplainHiddenImages: () => ({ hasHidden: false }),
  ExplainHiddenImages: () => null,
}));
vi.mock('~/components/ContainerProvider/useContainerSmallerThan', () => ({
  useContainerSmallerThan: () => false,
}));
vi.mock('~/components/Tours/ToursProvider', () => ({
  useTourContext: () => ({ running: false, helpers: undefined }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({}) }));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  const ImageGuard2 = ({ children }: any) => <>{children(true)}</>;
  ImageGuard2.BlurToggle = function BlurToggle() {
    return <span data-testid="blur-toggle" />;
  };
  return { ImageGuard2 };
});
vi.mock('~/components/ImagePreview/ImagePreview', () => ({ ImagePreview: () => null }));
vi.mock('~/components/Reaction/Reactions', () => ({ Reactions: () => null }));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Image/Meta/ImageMetaPopover', () => ({ ImageMetaPopover2: () => null }));
vi.mock('~/components/Image/Remix/RemixMenu', () => ({
  RemixMenu: () => null,
  isRemixMenuVisible: () => false,
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RoutedDialogLink: ({ children }: any) => <span>{children}</span>,
}));
vi.mock('~/components/TrackView/ImpressionSentinel', () => ({ ImpressionSentinel: () => null }));
vi.mock('~/components/Cosmetics/EventDecoration/WornHatPopover', () => ({
  WornHatPopover: ({ children }: any) => <span>{children}</span>,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ className }: any) => <img src={HAT_URL} className={className} alt="" />,
}));

import '~/styles/globals.css';
import { renderWithProviders } from '../../../../test/component-setup';
import { ModelCarousel } from '~/components/Model/ModelCarousel/ModelCarousel';

const rect = (el: Element | null | undefined) => el!.getBoundingClientRect();
const hats = () => [...document.querySelectorAll('button[data-event-decoration="hat"]')];

describe('a hat on a model page carousel picture', () => {
  test('hangs past the picture corner: above and left of it, whole in the page', async () => {
    await page.viewport(1100, 800);
    renderWithProviders(
      <div data-testid="root" style={{ width: 1000, margin: '80px 50px' }}>
        <ModelCarousel modelId={1} modelVersionId={2} modelUserId={9} limit={3} />
      </div>
    );
    await vi.waitFor(() => expect(hats().length).toBeGreaterThan(0));
    const root = rect(document.querySelector('[data-testid="root"]'));
    const slides = [...document.querySelectorAll('.relative.w-full')].filter(
      (el) => el.querySelector('[data-testid="blur-toggle"]') && rect(el).width > 100
    );
    const first = slides.reduce((a, b) => (rect(b).left < rect(a).left ? b : a));
    let h!: Element;
    await vi.waitFor(() => {
      h = hats().find((el) => Math.abs(rect(el).left - rect(first).left) < 80)!;
      expect(h).toBeTruthy();
    });
    expect(rect(first).top - rect(h).top).toBeGreaterThanOrEqual(34);
    expect(rect(first).left - rect(h).left).toBeGreaterThanOrEqual(24);
    expect(rect(h).left).toBeGreaterThanOrEqual(root.left - 40);
    // Two pictures are in view and only the first wears a hat; the third, out of view, has none drawn.
    expect(hats()).toHaveLength(1);
  });
});
