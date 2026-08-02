import { describe, expect, test, vi, beforeEach } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The announcement banner cannot be destroyed by an interrupted or failed upload.
 *
 * `metadata.image` is a bare object key with no foreign key and no refcount, and losing
 * it takes the sitewide banner down for everyone. Replacing a banner is a two-step
 * gesture — remove, then drop — and the upload widget only writes the new key into form
 * state once the upload succeeds. So the window between "removed" and "uploaded" is a
 * window in which Save persists *no image*.
 *
 * These tests drive the real modal (real form, real upload widget, mocked network) and
 * pin both halves of the guard: Save cannot land mid-upload, and a FAILED upload puts
 * the previous key back rather than leaving the cleared value for the next Save.
 */

const mocks = vi.hoisted(() => ({
  behavior: 'success' as 'success' | 'fail' | 'hang',
  uploaded: { url: 'new-banner-key', objectUrl: 'blob:new', id: 'new-banner-key', type: 'image' },
  mutate: vi.fn(),
}));

vi.mock('~/hooks/useCFImageUpload', async () => {
  const { useState } = await import('react');
  return {
    useCFImageUpload: () => {
      const [files, setFiles] = useState<Record<string, unknown>[]>([]);
      return {
        files,
        removeImage: () => undefined,
        resetFiles: () => setFiles([]),
        uploadToCF: async () => {
          if (mocks.behavior === 'hang') return new Promise(() => undefined);
          setFiles([{ ...mocks.uploaded, status: 'uploading', progress: 0 }]);
          await new Promise((r) => setTimeout(r, 0));
          if (mocks.behavior === 'fail') {
            setFiles([{ ...mocks.uploaded, status: 'error', progress: 0 }]);
            throw new Error('Upload failed (status 500)');
          }
          setFiles([{ ...mocks.uploaded, status: 'success', progress: 100 }]);
          return mocks.uploaded;
        },
      };
    },
  };
});

// Partial mock: other modules in the graph import unrelated named exports from here
// (`setTrpcBatchingEnabled`), and replacing the module wholesale breaks their import.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      announcement: { getAnnouncementsPaged: { invalidate: vi.fn() } },
    }),
    announcement: {
      upsertAnnouncement: {
        useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
      },
      getAnnouncementTargets: {
        useQuery: () => ({ data: [], isSuccess: true }),
      },
    },
  },
}));

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn(), zIndex: 200 }),
}));

vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => <img alt="preview" data-testid="preview" src={src} />,
}));
vi.mock('~/utils/application-error', () => ({ reportApplicationError: vi.fn() }));

import { AnnouncementEditModal } from '~/components/Announcements/AnnouncementEditModal';

const EXISTING_KEY = 'existing-banner-key';

const existingAnnouncement = {
  id: 42,
  title: 'Scheduled maintenance',
  content: 'Back shortly.',
  color: 'blue',
  domain: [],
  startsAt: new Date('2026-07-27T00:00:00.000Z'),
  endsAt: null,
  metadata: { image: EXISTING_KEY },
} as never;

async function findByText<T extends HTMLElement>(selector: string, text: string) {
  await expect
    .poll(
      () =>
        [...document.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text) ??
        null,
      { message: `expected a ${selector} labelled "${text}"` }
    )
    .not.toBeNull();
  return [...document.querySelectorAll(selector)].find(
    (el) => el.textContent?.trim() === text
  ) as T;
}

/**
 * The upload widget's remove control. Selected by its overlay positioning classes — the
 * modal's own close button is also icon-only, so "the button with no text" is ambiguous.
 */
const REMOVE_CONTROL = 'button[class*="right-1"][class*="top-1"]';

async function removeBanner() {
  await expect
    .poll(() => document.querySelector('[data-testid="preview"]'), {
      message: 'the existing banner preview should render',
    })
    .not.toBeNull();
  await expect
    .poll(() => document.querySelector(REMOVE_CONTROL), {
      message: 'expected the remove-image control',
    })
    .not.toBeNull();
  (document.querySelector(REMOVE_CONTROL) as HTMLElement).click();
}

async function dropBanner() {
  await expect
    .poll(() => document.querySelector('input[type="file"]'), {
      message: 'the dropzone should be available after removing the banner',
    })
    .not.toBeNull();
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const transfer = new DataTransfer();
  transfer.items.add(new File(['x'], 'banner.png', { type: 'image/png' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Wait for the banner preview to settle on a given source.
 *
 * Load-bearing: a drop is processed asynchronously, so clicking Save straight after
 * `dropBanner()` races the re-render and would pass for the wrong reason. The preview
 * src is the observable end state of the upload — the new object URL on success, the
 * restored key on failure.
 */
async function waitForPreviewSrc(fragment: string) {
  await expect
    .poll(() => document.querySelector('[data-testid="preview"]')?.getAttribute('src') ?? null, {
      message: `expected the banner preview to settle on "${fragment}"`,
    })
    .toContain(fragment);
}

const savedImage = () => mocks.mutate.mock.calls.at(-1)?.[0]?.metadata?.image;

describe('AnnouncementEditModal banner safety', () => {
  beforeEach(() => {
    mocks.behavior = 'success';
    mocks.mutate.mockClear();
  });

  test('saving an untouched announcement round-trips the stored key byte-identically', async () => {
    renderWithProviders(<AnnouncementEditModal announcement={existingAnnouncement} />);

    (await findByText<HTMLButtonElement>('button', 'Save')).click();

    await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
    expect(savedImage()).toBe(EXISTING_KEY);
  });

  test('Save is blocked while a replacement upload is in flight', async () => {
    mocks.behavior = 'hang';
    renderWithProviders(<AnnouncementEditModal announcement={existingAnnouncement} />);

    await removeBanner();
    await dropBanner();

    // 🔴 The window in which a save used to persist `image: undefined` and kill the
    // live sitewide banner.
    const save = await findByText<HTMLButtonElement>('button', 'Uploading image…');
    expect(save.disabled).toBe(true);

    save.click();
    // Belt-and-braces: the submit handler refuses even if the click gets through
    // (a disabled button does not stop an Enter-key submit).
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('a failed replacement restores the previous key instead of saving no banner', async () => {
    mocks.behavior = 'fail';
    renderWithProviders(<AnnouncementEditModal announcement={existingAnnouncement} />);

    await removeBanner();
    await dropBanner();

    // 🔴 The previous banner is put back rather than left cleared — visible to the
    // moderator, not just recovered silently in form state.
    await waitForPreviewSrc(EXISTING_KEY);

    // And the button is usable again — a failed upload must not trap the moderator.
    const save = await findByText<HTMLButtonElement>('button', 'Save');
    expect(save.disabled).toBe(false);
    save.click();

    await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
    expect(savedImage()).toBe(EXISTING_KEY);
  });

  test('a successful replacement saves the NEW key', async () => {
    mocks.behavior = 'success';
    renderWithProviders(<AnnouncementEditModal announcement={existingAnnouncement} />);

    await removeBanner();
    await dropBanner();
    await waitForPreviewSrc('blob:new');

    const save = await findByText<HTMLButtonElement>('button', 'Save');
    expect(save.disabled).toBe(false);
    save.click();

    await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
    expect(savedImage()).toBe('new-banner-key');
  });

  test('an explicit remove with no replacement drops the key entirely', async () => {
    renderWithProviders(<AnnouncementEditModal announcement={existingAnnouncement} />);

    await removeBanner();
    (await findByText<HTMLButtonElement>('button', 'Save')).click();

    await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
    // `announcementMetaSchema.image` is `z.string().optional()` — undefined, never null
    // and never an empty string.
    expect(savedImage()).toBeUndefined();
  });
});
