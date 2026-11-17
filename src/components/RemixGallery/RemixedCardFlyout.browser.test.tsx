import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as BatchProvider from '~/components/RemixGallery/RemixGalleryBatchProvider';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as UserHoverCard from '~/components/UserAvatar/UserHoverCard';
import type * as UseTrackImpression from '~/components/TrackView/useTrackImpression';
import { useRemixPeelStore } from '~/components/RemixGallery/remix-card-state';

/**
 * A remix seen in the hover strip is a view of that remix: event view points
 * are awarded only from impression beacons, so a strip tile that registers
 * nothing earns its creator nothing however often it is opened.
 */

const HOST = 10;
const SHOWN = 21;
const BLURRED = 22;

const mocks = vi.hoisted(() => ({
  trackImpression: vi.fn(),
  // Each tile gets its own ref; kept so a test can assert they reached the DOM.
  // Asserting the hook's argument alone stays green if the ref is dropped, and
  // the real hook only observes `ref.current`.
  refs: [] as { current: HTMLElement | null }[],
}));

vi.mock('~/components/TrackView/useTrackImpression', async (importOriginal) => ({
  ...(await importOriginal<typeof UseTrackImpression>()),
  useTrackImpression: (targets: unknown) => {
    mocks.trackImpression(targets);
    const ref = { current: null as HTMLElement | null };
    mocks.refs.push(ref);
    return ref;
  },
}));

vi.mock('~/components/RemixGallery/RemixGalleryBatchProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BatchProvider>()),
  useRemixGalleryBatch: () => ({
    count: 2,
    entries: [
      { imageId: SHOWN, url: 'shown.jpg', type: 'image', nsfwLevel: 1, username: 'shown' },
      { imageId: BLURRED, url: 'blurred.jpg', type: 'image', nsfwLevel: 4, username: 'blurred' },
    ],
  }),
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  // Level 4 blurred, level 1 shown.
  useBrowsingLevelContext: () => ({ blurLevels: 4 }),
}));

vi.mock('~/components/UserAvatar/UserHoverCard', async (importOriginal) => ({
  ...(await importOriginal<typeof UserHoverCard>()),
  useHoverCapable: () => true,
}));

afterEach(() => {
  useRemixPeelStore.getState().close();
  mocks.trackImpression.mockClear();
  mocks.refs = [];
});

async function renderOpen() {
  const { RemixedCardFlyout } = await import('~/components/RemixGallery/RemixedCardFlyout');
  renderWithProviders(
    <div style={{ position: 'relative', width: 320 }}>
      <div className="overflow-hidden" style={{ width: 300, height: 300 }}>
        <RemixedCardFlyout imageId={HOST} />
      </div>
    </div>
  );
  useRemixPeelStore.getState().toggle(HOST);
  await expect.element(page.getByRole('button', { name: "Open shown's remix" })).toBeVisible();
}

const registered = () =>
  mocks.trackImpression.mock.calls.flatMap(([targets]) => (targets as unknown[]) ?? []);

describe('remix flyout tiles report impressions', () => {
  test('a shown tile registers its remix image, on the tile itself', async () => {
    await renderOpen();

    expect(registered()).toContainEqual({ entityType: 'Image', entityId: SHOWN });
    const tile = page.getByRole('button', { name: "Open shown's remix" }).element();
    expect(mocks.refs.some((ref) => ref.current === tile)).toBe(true);
  });

  test('a blurred placeholder tile registers nothing: nothing of the remix was seen', async () => {
    await renderOpen();

    expect(registered()).not.toContainEqual({ entityType: 'Image', entityId: BLURRED });
  });

  test('a closed flyout registers nothing', async () => {
    const { RemixedCardFlyout } = await import('~/components/RemixGallery/RemixedCardFlyout');
    renderWithProviders(
      <div className="overflow-hidden" style={{ width: 300, height: 300 }}>
        <RemixedCardFlyout imageId={HOST} />
      </div>
    );
    await expect.element(page.getByRole('button', { name: /remix/ })).not.toBeInTheDocument();

    expect(registered()).toEqual([]);
  });
});
