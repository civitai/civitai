// The real cascade (layer order first, as `_document.tsx` declares it), so the hover/focus reveal
// below is measured against the styles the app renders.
import '../../../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as TrpcModule from '~/utils/trpc';
import type {
  PostEditImageDetail,
  SongCover as SongCoverRow,
} from '~/server/services/post.service';

const KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';

type Tracked = { file: File; progress: number; status: string; url: string; objectUrl: string };

const mocks = vi.hoisted(() => ({
  setCover: vi.fn(),
  updateImage: vi.fn(),
  uploadToCF: vi.fn(),
  setFiles: undefined as unknown as (update: (files: Tracked[]) => Tracked[]) => void,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'image.setSongCover': { useMutation: () => ({ mutateAsync: mocks.setCover }) },
    }),
  };
});
// The real hook PUTs to storage; this one tracks the picked file the same way and lets each test
// move it through progress, success or failure.
vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => {
    const [files, setFiles] = useState<Tracked[]>([]);
    mocks.setFiles = (update) => setFiles(update);
    return {
      files: files.map((x) => ({
        ...x,
        width: 600,
        height: 600,
        hash: 'h',
        mimeType: 'image/png',
      })),
      resetFiles: () => setFiles([]),
      removeImage: vi.fn(),
      uploadToCF: (file: File) => {
        setFiles([{ file, progress: 0, status: 'uploading', url: KEY, objectUrl: 'blob:preview' }]);
        return mocks.uploadToCF(file);
      },
    };
  },
}));
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ updateImage: mocks.updateImage }),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (orig) => ({
  ...(await orig<object>()),
  EdgeMedia: ({ src }: { src: string }) => <div data-testid="cover-media" data-src={src} />,
}));
vi.mock('~/hooks/useCurrentUser', async (orig) => ({
  ...(await orig<object>()),
  useCurrentUser: () => ({ id: 5 }),
}));

// eslint-disable-next-line import/first
import { SongCover } from '~/components/Post/EditV2/PostImageCards/SongCover';

const scanned: SongCoverRow = {
  id: 101,
  url: 'cover-key',
  ingestion: 'Scanned',
  nsfwLevel: 1,
  blockedFor: null,
};

const song = (cover: SongCoverRow | null = null) =>
  ({
    id: 7,
    type: 'audio',
    url: 'song-key',
    metadata: { duration: 120, ...(cover && { coverImageId: cover.id }) },
    cover,
  } as unknown as PostEditImageDetail);

async function renderCover(cover: SongCoverRow | null = null) {
  const screen = await renderWithProviders(
    <div className="w-[320px]">
      <SongCover image={song(cover)} />
    </div>
  );
  const input = screen.container.querySelector('input[type="file"]') as HTMLInputElement;
  // Handed over in the page itself: `userEvent.upload` re-creates the file from its bytes.
  const choose = (file: File) => {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return { screen, choose };
}

const png = (size = 1024) => new File([new Uint8Array(size)], 'cover.png', { type: 'image/png' });

const coverMedia = () => document.querySelector('[data-testid="cover-media"]');

beforeEach(() => {
  mocks.setCover.mockReset();
  mocks.updateImage.mockReset();
  mocks.uploadToCF.mockReset();
  mocks.uploadToCF.mockReturnValue(new Promise(() => undefined));
});

describe("a song's cover in the post editor", () => {
  test('without a cover, shows the music placeholder and invites an upload', async () => {
    await renderCover();

    await expect.element(page.getByRole('button', { name: 'Add cover' })).toBeVisible();
    await expect.element(page.getByTestId('song-tile')).toBeVisible();
    expect(coverMedia()).toBeNull();
  });

  test('shows a scanned cover, with Change cover revealed on keyboard focus', async () => {
    await renderCover(scanned);

    expect(coverMedia()?.getAttribute('data-src')).toBe('cover-key');
    const change = page.getByRole('button', { name: 'Change cover' });
    const label = change.element().querySelector('span')!;
    // Always shown on a device without hover; an earlier file's touch emulation can leave the
    // shared browser in that state.
    const noHover = matchMedia('(hover: none)').matches;
    expect(getComputedStyle(label).opacity).toBe(noHover ? '1' : '0');

    await userEvent.tab();

    await expect.element(change).toHaveFocus();
    await expect.poll(() => getComputedStyle(label).opacity).toBe('1');
  });

  test('uploads a chosen image with visible progress, the control disabled meanwhile', async () => {
    const { choose } = await renderCover();

    choose(png());
    mocks.setFiles((files) => [{ ...files[0], progress: 42 }]);

    await expect.element(page.getByText('Uploading 42%')).toBeVisible();
    await expect
      .element(page.getByRole('progressbar', { name: 'Cover upload progress' }))
      .toHaveAttribute('aria-valuenow', '42');
    await expect.element(page.getByRole('button', { name: 'Add cover' })).toBeDisabled();
    expect(mocks.uploadToCF).toHaveBeenCalledTimes(1);
  });

  test('links the finished upload and keeps the result in the editor store', async () => {
    const pending: SongCoverRow = { ...scanned, ingestion: 'Pending', nsfwLevel: 0 };
    mocks.setCover.mockResolvedValue(pending);
    const { choose } = await renderCover();

    choose(png());
    mocks.setFiles((files) => [{ ...files[0], progress: 100, status: 'success' }]);

    await vi.waitFor(() => expect(mocks.updateImage).toHaveBeenCalledTimes(1));
    expect(mocks.setCover).toHaveBeenCalledTimes(1);
    expect(mocks.setCover).toHaveBeenCalledWith({
      id: 7,
      cover: { url: KEY, width: 600, height: 600, hash: 'h', mimeType: 'image/png', type: 'image' },
    });
    const [songId, apply] = mocks.updateImage.mock.calls[0];
    const stored = song();
    apply(stored);
    expect(songId).toBe(7);
    expect(stored.cover).toEqual(pending);
    expect(stored.metadata).toEqual({ duration: 120, coverImageId: pending.id });
  });

  test('shows a cover still being scanned as processing, not as a clean cover', async () => {
    await renderCover({ ...scanned, ingestion: 'Pending' });

    await expect.element(page.getByText('Processing')).toBeVisible();
    expect(coverMedia()).toBeNull();
    await expect.element(page.getByRole('button', { name: 'Change cover' })).toBeInTheDocument();
  });

  // After a reload there is no local preview: the status must not sit on top of the music glyph.
  const glyphsOutsideStatus = (root: Element) =>
    [...root.querySelectorAll('svg')].filter((svg) => !svg.closest('[role="status"], button'));

  test('a cover being processed with nothing to show is the status alone, no music glyph', async () => {
    const { screen } = await renderCover({ ...scanned, ingestion: 'Pending' });

    await expect.element(page.getByText('Processing')).toBeVisible();
    expect(glyphsOutsideStatus(screen.container)).toHaveLength(0);
  });

  test('an upload with no preview to show is the status alone, no music glyph', async () => {
    const { screen, choose } = await renderCover();

    choose(png());
    mocks.setFiles((files) => [{ ...files[0], objectUrl: '', progress: 10 }]);

    await expect.element(page.getByText('Uploading 10%')).toBeVisible();
    expect(glyphsOutsideStatus(screen.container)).toHaveLength(0);
  });

  test('shows a blocked cover as blocked, with Change cover offered', async () => {
    await renderCover({ ...scanned, ingestion: 'Blocked', nsfwLevel: 32, blockedFor: 'moderated' });

    await expect.element(page.getByText('This cover was blocked')).toBeVisible();
    expect(coverMedia()).toBeNull();
    await expect.element(page.getByRole('button', { name: 'Change cover' })).toBeVisible();
  });

  test('reports a failed save in plain words and retries the same upload', async () => {
    mocks.setCover.mockRejectedValueOnce(new Error('INTERNAL_SERVER_ERROR'));
    mocks.setCover.mockResolvedValueOnce(scanned);
    const { choose } = await renderCover();

    choose(png());
    mocks.setFiles((files) => [{ ...files[0], progress: 100, status: 'success' }]);

    await expect
      .element(page.getByText("The cover uploaded but couldn't be saved. Try again."))
      .toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Retry' }));

    await vi.waitFor(() => expect(mocks.updateImage).toHaveBeenCalledTimes(1));
    expect(mocks.setCover).toHaveBeenCalledTimes(2);
    expect(mocks.setCover.mock.calls[1]).toEqual(mocks.setCover.mock.calls[0]);
    expect(mocks.uploadToCF).toHaveBeenCalledTimes(1);
  });

  test('reports a failed upload and uploads the same file again on retry', async () => {
    const { choose } = await renderCover();
    const file = png();

    choose(file);
    mocks.setFiles((files) => [{ ...files[0], status: 'error' }]);

    await expect
      .element(page.getByText("The cover didn't upload. Check your connection and try again."))
      .toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Retry' }));

    expect(mocks.uploadToCF).toHaveBeenCalledTimes(2);
    expect(mocks.uploadToCF.mock.calls[1][0]).toBe(mocks.uploadToCF.mock.calls[0][0]);
    expect(mocks.setCover).not.toHaveBeenCalled();
  });

  test('refuses an image over the size limit with the usual message, uploading nothing', async () => {
    const { choose } = await renderCover();

    choose(png(51 * 1024 ** 2));

    await expect.element(page.getByText('Images should not exceed 50 MB')).toBeVisible();
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
  });
});
