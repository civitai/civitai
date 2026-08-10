import type { ComponentProps, ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

// =============================================================================
// CollectionCard covers — a video cover must be requested as a transcoded still.
// =============================================================================
//
// `ImageCover` pins `type="image"` so the card never mounts EdgeVideo.
// `getInferredMediaType` returns `options.type` when it is supplied, so that pin
// also makes `useEdgeUrl`'s `inferredType === 'video' && type === 'image'` branch
// — the one that would otherwise set `transcode` for us — unreachable. Without an
// explicit `transcode`, the delivery URL asks the CDN for a video asset as a
// plain image.
//
// EdgeMedia/EdgeImage/getEdgeUrl are REAL here; the assertion is on the emitted
// `img[src]`. Only the card's non-media surroundings are stubbed.

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false, filePreferences: {} }),
}));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: <T,>(selector: (state: { autoplayGifs: boolean }) => T) =>
    selector({ autoplayGifs: false }),
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  function ImageGuard2({ children }: { children: (safe: boolean) => ReactNode }) {
    return <>{children(true)}</>;
  }
  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
  return { ImageGuard2 };
});
vi.mock('~/components/Collections/components/CollectionContextMenu', () => ({
  CollectionContextMenu: function CollectionContextMenu({ children }: { children: ReactNode }) {
    return <>{children}</>;
  },
}));

import { ImageCover } from './CollectionCard';
import { renderWithProviders } from '../../../test/component-setup';
import { MediaType } from '~/shared/utils/prisma/enums';
import { NsfwLevel } from '~/server/common/enums';

type CoverImage = ComponentProps<typeof ImageCover>['coverImages'][number];

const headerData: ComponentProps<typeof ImageCover>['data'] = {
  id: 1,
  userId: 2,
  type: null,
  mode: null,
};

function coverImage(overrides: Partial<CoverImage> = {}): CoverImage {
  return {
    id: 10,
    nsfwLevel: NsfwLevel.PG,
    url: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    type: MediaType.image,
    name: 'cover.jpeg',
    ...overrides,
  };
}

// The cover count is fixed by the props, and an <img> never leaves the tree once
// mounted, so waiting on it is waiting on an absorbing state.
async function renderedSrcs(ui: React.ReactElement, expected: number) {
  renderWithProviders(ui);
  return vi.waitFor(() => {
    const srcs = Array.from(document.body.querySelectorAll('img')).map(
      (img) => img.getAttribute('src') ?? ''
    );
    expect(srcs).toHaveLength(expected);
    return srcs;
  });
}

describe('CollectionCard covers', () => {
  test('ImageCover requests a transcoded still for a video cover', async () => {
    const srcs = await renderedSrcs(
      <ImageCover
        data={headerData}
        coverImages={[coverImage({ type: MediaType.video, name: 'cover.mp4' })]}
      />,
      1
    );

    expect(srcs[0]).toContain('transcode=true');
  });

  test('ImageCover leaves a still image untranscoded', async () => {
    const srcs = await renderedSrcs(
      <ImageCover data={headerData} coverImages={[coverImage()]} />,
      1
    );

    expect(srcs[0]).not.toContain('transcode=true');
  });
});
