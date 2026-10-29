import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// Browser mode only: needs a real layout.

const HAT_URL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M5 0L10 10H0z" fill="#e64980"/></svg>'
  );

const image = (id: number, hatted = false) => ({
  id,
  type: 'image',
  url: `img-${id}.jpeg`,
  name: null,
  width: 600,
  height: 400,
  hasMeta: false,
  metadata: {},
  reactions: [],
  stats: {},
  user: { id: 9 },
  eventDecoration: hatted
    ? { id: 1, data: { type: 'hat', event: 'birthday2026', url: 'HAT' } }
    : null,
});

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/components/UserSettings/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUserSettings: () => ({}),
}));
vi.mock('~/components/Cosmetics/EventDecoration/WornHatPopover', () => ({
  WornHatPopover: ({ children }: any) => <span>{children}</span>,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ imageId, className }: any) =>
    imageId == null ? (
      <img src={HAT_URL} className={className} alt="" />
    ) : (
      <div data-testid="media" className="size-full bg-slate-600" />
    ),
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  const ImageGuard2 = ({ children }: any) => <>{children(true)}</>;
  ImageGuard2.BlurToggle = function BlurToggle() {
    return <span data-testid="blur-toggle" />;
  };
  return { ImageGuard2 };
});
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RoutedDialogLink: ({ children }: any) => <a>{children}</a>,
}));
vi.mock('~/components/Sticker/StickerPlacementBatchProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  StickerPlacementBatchProvider: ({ children }: any) => <>{children}</>,
}));
vi.mock('~/components/Ads/AdUnit', () => ({ AdUnitTop: () => null }));
vi.mock('~/components/ImageHash/ImageHash', () => ({ MediaHash: () => null }));
vi.mock('~/components/Reaction/Reactions', () => ({ Reactions: () => null }));
vi.mock('~/components/Image/ContextMenu/ImageContextMenu', () => ({
  ImageContextMenu: () => null,
}));
vi.mock('~/components/Image/Meta/ImageMetaPopover', () => ({ ImageMetaPopover2: () => null }));
vi.mock('~/components/Post/Detail/PostContestCollectionInfoAlert', () => ({
  PostContestCollectionInfoAlert: () => null,
}));

import '~/styles/globals.css';
import { renderWithProviders } from '../../../../test/component-setup';
import { PostImages } from '~/components/Post/Detail/PostImages';

const rect = (el: Element | null | undefined) => el!.getBoundingClientRect();
const hats = () => [...document.querySelectorAll('button[data-event-decoration="hat"]')];

describe('a hat on a post page image', () => {
  test('hangs past the picture corner', async () => {
    await page.viewport(1100, 800);
    renderWithProviders(
      <div data-testid="root" style={{ width: 800, margin: '80px 100px' }}>
        <PostImages postId={100} images={[image(1), image(2, true)] as any} />
      </div>
    );
    await vi.waitFor(() => expect(hats()).toHaveLength(1));
    const h = hats()[0];
    const media = [...document.querySelectorAll('[data-testid="media"]')][1];
    expect(rect(media).top - rect(h).top).toBeGreaterThanOrEqual(34);
    expect(rect(media).left - rect(h).left).toBeGreaterThanOrEqual(24);
  });
});
