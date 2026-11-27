import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';
import type * as ImageHashModule from '~/components/ImageHash/ImageHash';
import type * as EdgeMediaModule from '~/components/EdgeMedia/EdgeMedia';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as ImagesProviderModule from '~/components/Image/Providers/ImagesProvider';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { NsfwLevel } from '~/server/common/enums';
import type { EmbedImage } from '~/components/CivitaiEmbed/CivitaiEmbedProvider';

// The real ImageGuard2 decides; only the media it chooses between are stand-ins.
const settings = vi.hoisted(() => ({ browsingLevel: 1, blurNsfw: false }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ canViewNsfw: true }),
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsModule>()),
  useBrowsingSettings: (selector: (s: unknown) => unknown) =>
    selector({
      showNsfw: true,
      browsingLevel: settings.browsingLevel,
      blurNsfw: settings.blurNsfw,
    }),
}));
vi.mock('~/components/Image/Providers/ImagesProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ImagesProviderModule>()),
  useImagesContext: () => ({ getImages: () => [] }),
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({
    children,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    'aria-label'?: string;
  }) => (
    <a href="#" aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof EdgeMediaModule>()),
  EdgeMedia2: ({ src, videoProps }: { src: string; videoProps?: { keepPlaying?: boolean } }) => (
    <div
      data-testid="edge-media"
      data-src={src}
      data-keep-playing={videoProps?.keepPlaying ? 'true' : undefined}
    />
  ),
}));
vi.mock('~/components/ImageHash/ImageHash', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageHashModule>()),
  MediaHash: () => <div data-testid="media-hash" />,
}));

const { FullWidthMedia } = await import('~/components/CivitaiEmbed/CivitaiEmbedBlock');

const media = (type: 'image' | 'video') =>
  ({
    id: type === 'image' ? 8 : 10,
    type,
    url: `mature-${type}`,
    name: null,
    nsfwLevel: NsfwLevel.R,
    hash: 'U00000fQfQfQfQfQfQfQfQfQfQfQ',
    width: 800,
    height: 600,
    metadata: {},
    user: { id: 1 },
  } as unknown as EmbedImage);

function renderFull(type: 'image' | 'video') {
  return renderWithProviders(
    <BrowsingLevelProvider>
      <FullWidthMedia item={{ type: 'image', id: media(type).id }} data={media(type)} />
    </BrowsingLevelProvider>,
    { user: { id: 9 } }
  );
}

beforeEach(() => Object.assign(settings, { browsingLevel: NsfwLevel.PG, blurNsfw: false }));

describe('the full-width view of a mature item', () => {
  test.each(['image', 'video'] as const)(
    'a %s above the viewer level shows the blurhash, never the media',
    async (type) => {
      renderFull(type);

      await expect.element(page.getByTestId('media-hash')).toBeInTheDocument();
      expect(page.getByTestId('edge-media').elements()).toHaveLength(0);
    }
  );

  test.each(['image', 'video'] as const)(
    'a %s is blurred with blur on, even inside the viewer level',
    async (type) => {
      Object.assign(settings, { browsingLevel: NsfwLevel.PG | NsfwLevel.R, blurNsfw: true });
      renderFull(type);

      await expect.element(page.getByTestId('media-hash')).toBeInTheDocument();
      expect(page.getByTestId('edge-media').elements()).toHaveLength(0);
    }
  );

  test('the media shows once the level covers it and blur is off', async () => {
    settings.browsingLevel = NsfwLevel.PG | NsfwLevel.R;
    renderFull('image');

    await expect.element(page.getByTestId('edge-media')).toBeInTheDocument();
    expect(page.getByTestId('media-hash').elements()).toHaveLength(0);
  });
});

describe('the full-width view of a video', () => {
  beforeEach(() => (settings.browsingLevel = NsfwLevel.PG | NsfwLevel.R));

  test('a video embed opts in to keep playing once started', async () => {
    renderFull('video');
    await expect
      .element(page.getByTestId('edge-media'))
      .toHaveAttribute('data-keep-playing', 'true');
  });

  test('the viewer opens from a labelled icon link, not a text link', async () => {
    renderFull('video');
    const open = page.getByRole('link', { name: 'Open in viewer' });
    await expect.element(open).toBeInTheDocument();
    await expect.element(open).not.toHaveTextContent('Open');
  });

  test('an image has no corner link', async () => {
    renderFull('image');
    await expect.element(page.getByTestId('edge-media')).toBeInTheDocument();
    expect(page.getByRole('link', { name: 'Open in viewer' }).elements()).toHaveLength(0);
  });
});
