import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as NotificationsMod from '~/utils/notifications';
import type * as TrpcMod from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * The civitai.red icon / cover OVERRIDE section of the listing asset step: the author sets,
 * replaces and clears each slot through the step's own upload → persist → attach path, with only
 * the attach call swapped for `setRedMedia`. The section is driven by the `redMedia` prop the
 * editors pass from their prefill read; without it (the create wizard) nothing renders.
 *
 * Fixture ids are pairwise distinct: listing `apl_red_step`, prefilled red icon 811 / red cover
 * 822, uploaded images 833 / 844 / 855, regular icon 866 / cover 877.
 */

const mocks = vi.hoisted(() => ({
  setRedMedia: vi.fn(),
  setIcon: vi.fn(),
  setCover: vi.fn(),
  persist: vi.fn(),
  uploadToCF: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const mutation = (fn: unknown) => ({
    useMutation: () => ({ mutate: vi.fn(), mutateAsync: fn, isPending: false }),
  });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'appListings.setRedMedia': mutation(mocks.setRedMedia),
      'appListings.setIcon': mutation(mocks.setIcon),
      'appListings.setCover': mutation(mocks.setCover),
      'appListings.persistAssetImage': mutation(mocks.persist),
    }),
  };
});
vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({ uploadToCF: mocks.uploadToCF, files: [], resetFiles: vi.fn() }),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsMod>()),
  showErrorNotification: mocks.showErrorNotification,
}));

const { ListingAssetStep } = await import('./ListingAssetStep');

const LISTING = 'apl_red_step';
const initial = {
  icon: { imageId: 866, url: LOADABLE_IMAGE_DATA_URI },
  cover: { imageId: 877, url: LOADABLE_IMAGE_DATA_URI },
  screenshots: [],
};
const EMPTY = { imageId: null, url: null };
const redMedia = (over: Record<string, unknown> = {}) => ({
  available: true,
  icon: EMPTY,
  cover: EMPTY,
  ...over,
});

type StepProps = Parameters<typeof ListingAssetStep>[0];
function renderStep(props: Partial<StepProps> = {}) {
  return renderWithProviders(
    <ListingAssetStep
      listingId={LISTING}
      contentRating="g"
      suggestions={{}}
      initial={initial}
      {...props}
    />
  );
}

async function makeImageFile(name: string, width: number, height: number): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob null'))), 'image/png');
  });
  return new File([blob], name, { type: 'image/png' });
}

/** The non-multiple file inputs in DOM order: icon, cover, then the red icon and red cover. */
function singleFileInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="file"]:not([multiple])')];
}
async function redInput(slot: 'icon' | 'cover'): Promise<HTMLInputElement> {
  return vi.waitFor(() => {
    const el = singleFileInputs()[slot === 'icon' ? 2 : 3];
    if (!el) throw new Error(`red ${slot} input not found`);
    return el;
  });
}

const normalise = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.uploadToCF.mockResolvedValue({ id: 'cf-upload' });
  mocks.setRedMedia.mockImplementation(
    async (input: { slot: 'icon' | 'cover'; imageId: number | null }) =>
      input.imageId == null
        ? { status: 'cleared', slot: input.slot }
        : { status: 'attached', slot: input.slot, imageId: input.imageId, scanPending: false }
  );
});

describe('ListingAssetStep — civitai.red icon / cover overrides', () => {
  test('invariant guard: no `redMedia` (the create wizard) renders no civitai.red section', async () => {
    renderStep();
    await expect.element(page.getByTestId('apps-listing-assets-completeness')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-red-media').elements()).toHaveLength(0);
    expect(singleFileInputs()).toHaveLength(2);
  });

  test('🔴 the note says the images show only on civitai.red, may be mature, and civitai.com keeps the regular ones', async () => {
    renderStep({ redMedia: redMedia() });
    const note = page.getByTestId('apps-listing-red-media-note');
    await expect.element(note).toBeInTheDocument();
    expect(normalise(note.element().textContent)).toBe(
      'These images show only on civitai.red, in place of the icon and cover above, and may be mature. civitai.com always shows the regular icon and cover. Both are optional: an empty slot shows the regular image on civitai.red too.'
    );
  });

  test('🔴 slots unavailable on this environment: no picker, the server’s own reason instead', async () => {
    renderStep({ redMedia: redMedia({ available: false }) });
    const unavailable = page.getByTestId('apps-listing-red-media-unavailable');
    await expect.element(unavailable).toBeInTheDocument();
    expect(normalise(unavailable.element().textContent)).toBe(
      'A civitai.red-only icon or cover is not available on this environment yet. The listing shows its own icon and cover on every host.'
    );
    expect(page.getByTestId('apps-listing-red-media-note').elements()).toHaveLength(0);
    // Positive control for the count: the regular icon and cover inputs are still there.
    expect(singleFileInputs()).toHaveLength(2);
  });

  test('🔴 setting the red icon uploads it as an icon and attaches it through setRedMedia, never setIcon', async () => {
    const onAssetMutated = vi.fn();
    mocks.persist.mockResolvedValue({ imageId: 833 });
    renderStep({ redMedia: redMedia(), onAssetMutated });
    await userEvent.upload(await redInput('icon'), await makeImageFile('red-icon.png', 256, 256));
    await vi.waitFor(() =>
      expect(mocks.setRedMedia).toHaveBeenCalledWith({
        listingId: LISTING,
        slot: 'icon',
        imageId: 833,
      })
    );
    expect(mocks.setIcon).not.toHaveBeenCalled();
    expect(mocks.setCover).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ width: 256, height: 256 })
    );
    await vi.waitFor(() => expect(onAssetMutated).toHaveBeenCalledTimes(1));
    await expect
      .element(page.getByTestId('apps-offsite-current-red-icon-preview'))
      .toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-remove-red-icon')).toBeInTheDocument();
  });

  test('🔴 setting the red cover attaches the COVER slot', async () => {
    mocks.persist.mockResolvedValue({ imageId: 844 });
    renderStep({ redMedia: redMedia() });
    await userEvent.upload(
      await redInput('cover'),
      await makeImageFile('red-cover.png', 1280, 720)
    );
    await vi.waitFor(() =>
      expect(mocks.setRedMedia).toHaveBeenCalledWith({
        listingId: LISTING,
        slot: 'cover',
        imageId: 844,
      })
    );
    expect(mocks.setCover).not.toHaveBeenCalled();
  });

  test('🔴 a red icon is held to the ICON rules before upload (a landscape image is refused)', async () => {
    renderStep({ redMedia: redMedia() });
    await userEvent.upload(await redInput('icon'), await makeImageFile('wide.png', 1280, 720));
    await vi.waitFor(() => expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1));
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
    expect(mocks.setRedMedia).not.toHaveBeenCalled();
  });

  test('🔴 replacing a prefilled red icon attaches the new image to the same slot', async () => {
    mocks.persist.mockResolvedValue({ imageId: 855 });
    renderStep({
      redMedia: redMedia({ icon: { imageId: 811, url: LOADABLE_IMAGE_DATA_URI } }),
    });
    await expect.element(page.getByText('Replace civitai.red icon')).toBeInTheDocument();
    await userEvent.upload(await redInput('icon'), await makeImageFile('next.png', 300, 300));
    await vi.waitFor(() =>
      expect(mocks.setRedMedia).toHaveBeenCalledWith({
        listingId: LISTING,
        slot: 'icon',
        imageId: 855,
      })
    );
  });

  test('🔴 clearing a prefilled red cover calls setRedMedia with no image and empties the row', async () => {
    const onAssetMutated = vi.fn();
    renderStep({
      redMedia: redMedia({ cover: { imageId: 822, url: LOADABLE_IMAGE_DATA_URI } }),
      onAssetMutated,
    });
    await page.getByTestId('apps-offsite-remove-red-cover').click();
    await vi.waitFor(() =>
      expect(mocks.setRedMedia).toHaveBeenCalledWith({
        listingId: LISTING,
        slot: 'cover',
        imageId: null,
      })
    );
    await expect.element(page.getByText('Upload civitai.red cover')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-remove-red-cover').elements()).toHaveLength(0);
    expect(onAssetMutated).toHaveBeenCalledTimes(1);
    // The regular cover is untouched.
    expect(mocks.setCover).not.toHaveBeenCalled();
  });

  test('a failed clear keeps the slot attached and tells the author', async () => {
    const onAssetMutated = vi.fn();
    mocks.setRedMedia.mockRejectedValue(new Error('nope'));
    renderStep({
      redMedia: redMedia({ icon: { imageId: 811, url: LOADABLE_IMAGE_DATA_URI } }),
      onAssetMutated,
    });
    await page.getByTestId('apps-offsite-remove-red-icon').click();
    await vi.waitFor(() =>
      expect(mocks.showErrorNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Could not remove the civitai.red icon' })
      )
    );
    await expect.element(page.getByTestId('apps-offsite-remove-red-icon')).toBeInTheDocument();
    expect(onAssetMutated).not.toHaveBeenCalled();
  });

  test('🔴 the author sees their own R override plainly, with its rating badge (no browsing-level guard)', async () => {
    renderStep({
      redMedia: redMedia({ icon: { imageId: 811, url: LOADABLE_IMAGE_DATA_URI } }),
      rating: {
        declaredRating: 'g',
        listingRating: 'g',
        stage: 'not-live',
        // NsfwLevel bits: PG 1, R 4.
        assets: {
          iconId: 866,
          coverId: 877,
          iconNsfwLevel: 1,
          coverNsfwLevel: 1,
          screenshots: [],
          redIconId: 811,
          redIconNsfwLevel: 4,
        },
      },
    });
    const preview = page.getByTestId('apps-offsite-current-red-icon-preview');
    await expect.element(preview).toBeInTheDocument();
    expect(preview.element().getAttribute('src')).toBe(LOADABLE_IMAGE_DATA_URI);
    expect(page.getByTestId('apps-asset-rating-red-icon').element().textContent).toBe('Rated R');
  });

  const ratingWithRedIcon = (mediaSplit: boolean) => ({
    declaredRating: 'g',
    listingRating: 'g',
    stage: 'not-live' as const,
    mediaSplit,
    assets: {
      iconId: 866,
      coverId: 877,
      iconNsfwLevel: 1,
      coverNsfwLevel: 1,
      screenshots: [],
      redIconId: 811,
      redIconNsfwLevel: 4,
    },
  });
  const redIconPrefill = () => redMedia({ icon: { imageId: 811, url: LOADABLE_IMAGE_DATA_URI } });

  test('🔴 an unsplit listing’s rating callout counts the override', async () => {
    renderStep({ redMedia: redIconPrefill(), rating: ratingWithRedIcon(false) });
    await expect
      .element(page.getByTestId('apps-listing-rating-callout'))
      .toHaveTextContent('civitai.red icon (R)');
  });

  test('🔴 a split listing’s rating callout leaves the override out', async () => {
    renderStep({ redMedia: redIconPrefill(), rating: ratingWithRedIcon(true) });
    await expect.element(page.getByTestId('apps-listing-assets-completeness')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-asset-rating-red-icon')).toBeInTheDocument();
    for (const el of page.getByTestId('apps-listing-rating-callout').elements())
      expect(el.textContent).not.toContain('civitai.red icon');
  });
});
