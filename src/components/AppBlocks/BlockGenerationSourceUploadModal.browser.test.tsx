import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * BlockGenerationSourceUploadModal — the UNSCANNED `generationSource` upload path.
 *
 * Proves that a `generationSource` block image upload:
 *   1. uploads through the SAME consumer-blob util the generator uses
 *      (`uploadConsumerBlob`) — never `createImage`;
 *   2. resolves ONLY the source shape { url, width, height } (real dims from the
 *      blob via `getImageDimensions`);
 *   3. NEVER touches the moderated scan/gate service (blockImageUpload.persist /
 *      gate) — those trpc mutations are mocked with spies and asserted untouched,
 *      a regression guard even though this modal doesn't import them today.
 */

const mocks = vi.hoisted(() => ({
  uploadConsumerBlob: vi.fn(),
  getImageDimensions: vi.fn(),
  persistMutate: vi.fn(),
  gateMutate: vi.fn(),
}));

vi.mock('~/utils/consumer-blob-upload', () => ({
  uploadConsumerBlob: mocks.uploadConsumerBlob,
}));

vi.mock('~/utils/image-utils', async (orig) => {
  const actual = await orig<typeof import('~/utils/image-utils')>();
  return { ...actual, getImageDimensions: mocks.getImageDimensions };
});

// The moderated scan/gate service. This modal must NEVER call it — the spies
// stay untouched on the generationSource branch (the orchestrator scans the
// OUTPUT). Mocking a module the modal doesn't import is harmless, and it turns
// "someone later wires a scan into this path" into a red test.
vi.mock('~/utils/trpc', () => ({
  trpc: {
    blockImageUpload: {
      persist: { useMutation: () => ({ mutateAsync: mocks.persistMutate }) },
      gate: { useMutation: () => ({ mutateAsync: mocks.gateMutate }) },
    },
  },
}));

// eslint-disable-next-line import/first
import BlockGenerationSourceUploadModal from '~/components/AppBlocks/BlockGenerationSourceUploadModal';
// eslint-disable-next-line import/first
import { DialogProvider } from '~/components/Dialog/DialogProvider';
// eslint-disable-next-line import/first
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';

const BLOB_URL =
  'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=x&exp=2030-01-01T00:00:00Z';

/** A REAL png File (canvas → toBlob); uploadConsumerBlob is mocked so bytes are inert. */
async function makeImageFile(name = 'source.png'): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  return new File([blob], name, { type: 'image/png' });
}

/** The hidden native <input type=file> Mantine's FileInput renders. */
function fileInputEl(): Promise<HTMLInputElement> {
  return vi.waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('input[type="file"]:not([multiple])');
    if (!el) throw new Error('file input not found');
    return el;
  });
}

function openModal(onResolved: (r: unknown) => void) {
  renderWithProviders(<DialogProvider />);
  dialogStore.trigger({
    id: 'gen-source-test',
    component: BlockGenerationSourceUploadModal,
    props: { onResolved },
  });
}

describe('BlockGenerationSourceUploadModal (generationSource — unscanned source)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    mocks.uploadConsumerBlob.mockReset();
    mocks.getImageDimensions.mockReset();
    mocks.persistMutate.mockReset();
    mocks.gateMutate.mockReset();
  });

  test('uploads via uploadConsumerBlob and resolves { url, width, height } — no createImage/scan/gate', async () => {
    mocks.uploadConsumerBlob.mockResolvedValue({ url: BLOB_URL });
    mocks.getImageDimensions.mockResolvedValue({ width: 640, height: 480 });
    const onResolved = vi.fn();

    openModal(onResolved);
    await userEvent.upload(await fileInputEl(), await makeImageFile());

    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    // Exactly the source projection — no imageId / nsfwLevel / contentRating.
    expect(onResolved).toHaveBeenCalledWith({ url: BLOB_URL, width: 640, height: 480 });
    expect(Object.keys(onResolved.mock.calls[0][0]).sort()).toEqual(['height', 'url', 'width']);

    // Reused the generator's consumer-blob util with the real File.
    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(1);
    expect(mocks.uploadConsumerBlob.mock.calls[0][0]).toBeInstanceOf(File);
    // Real dims derived from the uploaded blob URL (mirrors SourceImageUpload).
    expect(mocks.getImageDimensions).toHaveBeenCalledWith(BLOB_URL);

    // The moderated scan/gate service is NEVER reached on this branch.
    expect(mocks.persistMutate).not.toHaveBeenCalled();
    expect(mocks.gateMutate).not.toHaveBeenCalled();
  });

  test('an upload failure surfaces an error and does NOT resolve (no partial source)', async () => {
    mocks.uploadConsumerBlob.mockRejectedValue(new Error('Failed to upload blob: 500'));
    const onResolved = vi.fn();

    openModal(onResolved);
    await userEvent.upload(await fileInputEl(), await makeImageFile());

    await expect.element(page.getByText(/Failed to upload blob/i)).toBeInTheDocument();
    expect(onResolved).not.toHaveBeenCalled();
    expect(mocks.persistMutate).not.toHaveBeenCalled();
    expect(mocks.gateMutate).not.toHaveBeenCalled();
  });
});
