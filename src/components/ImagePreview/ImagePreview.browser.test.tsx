import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The model page's carousel tile (ImagePreview): a moderator's image the CDN refuses, as it refuses
 * every image of a taken-down model, is loaded from `/api/mod/retracted-media`, as the gallery card
 * (ImagesCard) already is. Which images that route serves is the server's decision alone.
 */

const features: Record<string, boolean> = { modRetractedMedia: false };
const viewer = { isModerator: false };
/** Whether the mocked CDN media refuses to load. */
const cdn = { refuses: false };

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => features,
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: viewer.isModerator }),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => {
  const { useEffect } = await import('react');
  function EdgeMedia2({ onError }: { onError?: (e: { target: EventTarget | null }) => void }) {
    useEffect(() => {
      if (cdn.refuses) onError?.({ target: null });
    }, [onError]);
    return <div data-testid="cdn-mock" style={{ width: '100%', height: '100%' }} />;
  }
  return { ...(await importOriginal<object>()), EdgeMedia2 };
});

const ID = 990000701;
const image = (over: object = {}) => ({
  id: ID,
  url: `key-${ID}`,
  name: null,
  type: 'image' as const,
  width: 512,
  height: 768,
  hash: null,
  ingestion: 'Scanned' as const,
  ...over,
});

const routeImg = () => document.querySelector(`img[src="/api/mod/retracted-media/${ID}"]`);
const cdnTile = () => document.querySelector('[data-testid="cdn-mock"]');

async function render(img: object) {
  await renderWithProviders(<ImagePreview image={img as never} style={{ width: 300 }} />);
}

/** The mock refuses in its first effect; act flushes it, so a fallback would be committed here. */
async function settled() {
  await expect.poll(() => cdnTile() ?? routeImg()).not.toBeNull();
  await act(async () => undefined);
}

describe('a model carousel tile the CDN refuses', () => {
  const setUp = (isModerator: boolean, flag = true) => {
    viewer.isModerator = isModerator;
    features.modRetractedMedia = flag;
    cdn.refuses = true;
  };
  afterEach(() => {
    viewer.isModerator = false;
    features.modRetractedMedia = false;
    cdn.refuses = false;
  });

  test("moves a moderator's scanned image to the retracted-media route", async () => {
    setUp(true);
    await render(image());
    await expect.poll(routeImg).not.toBeNull();
  });

  test('loads a blocked image from the route from the start', async () => {
    setUp(true);
    cdn.refuses = false;
    await render(image({ ingestion: 'Blocked' }));
    await expect.poll(routeImg).not.toBeNull();
    expect(cdnTile()).toBeNull();
  });

  test('keeps everyone else on the CDN', async () => {
    setUp(false);
    await render(image());
    await settled();
    expect(routeImg()).toBeNull();
  });

  test('keeps a moderator on the CDN while the flag is off', async () => {
    setUp(true, false);
    await render(image());
    await settled();
    expect(routeImg()).toBeNull();
  });

  // The other callers pass images without `ingestion`; they keep the CDN as before.
  test('keeps an image with no ingestion on the CDN', async () => {
    setUp(true);
    await render(image({ ingestion: undefined }));
    await settled();
    expect(routeImg()).toBeNull();
  });
});
