import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as DialogStoreModule from '~/components/Dialog/dialogStore';
import type * as CanvasUtils from '~/shared/utils/canvas-utils';
import type * as ImageUtils from '~/utils/image-utils';

/**
 * A failed source-image upload must end on an error card with the spinner cleared, and must not
 * start the upload again. The upload pipeline below the component (dimensions, resize, re-encode,
 * consumer-blob upload) is mocked so each test controls when, and how, every upload settles.
 */

const mocks = vi.hoisted(() => ({
  uploadConsumerBlob: vi.fn(),
  getImageDimensions: vi.fn(),
  dialogTrigger: vi.fn(),
}));

vi.mock('~/utils/consumer-blob-upload', () => ({ uploadConsumerBlob: mocks.uploadConsumerBlob }));

vi.mock('~/utils/image-utils', async (orig) => ({
  ...(await orig<typeof ImageUtils>()),
  getImageDimensions: mocks.getImageDimensions,
}));

vi.mock('~/shared/utils/canvas-utils', async (orig) => ({
  ...(await orig<typeof CanvasUtils>()),
  resizeImage: vi.fn(async () => new Blob(['resized'], { type: 'image/png' })),
  imageToJpegBlob: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
}));

vi.mock('~/utils/metadata/extract-source-metadata', () => ({
  extractSourceMetadata: vi.fn(async () => undefined),
  extractSourceMetadataFromUrl: vi.fn(async () => undefined),
}));

// Only `trigger` is replaced, so the crop modal's callbacks can be driven directly.
vi.mock('~/components/Dialog/dialogStore', async (orig) => {
  const actual = await orig<typeof DialogStoreModule>();
  return { ...actual, dialogStore: { ...actual.dialogStore, trigger: mocks.dialogTrigger } };
});

// eslint-disable-next-line import/first
import { useImagesUploadingStore } from '~/components/Generation/Input/SourceImageUploadMultiple';
// eslint-disable-next-line import/first
import {
  ImageUploadMultipleInput,
  type ImageValue,
} from '~/components/generation_v2/inputs/ImageUploadMultipleInput';

const PRESIGN_ERROR = 'Failed to get upload URL';

type Deferred = { resolve: (v: unknown) => void; reject: (e: Error) => void; settled: boolean };
let uploads: Deferred[] = [];

function Harness(props: {
  max?: number;
  aspectRatios?: `${number}:${number}`[];
  layout?: 'default' | 'url-input';
}) {
  const [value, setValue] = useState<ImageValue[]>([]);
  // Ignores a write equal to the current value, as the form store does (it diffs field values with
  // deepEqual). Without it the input's empty-value write (a new `[]` each time nothing has
  // completed) re-renders it forever.
  const onChange = (next: ImageValue[]) =>
    setValue((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  return (
    <div data-testid="source-images">
      <ImageUploadMultipleInput value={value} onChange={onChange} max={props.max ?? 3} {...props} />
    </div>
  );
}

const imageFile = (name: string) =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });

async function pickFiles(count: number) {
  const input = await vi.waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(
      '[data-testid="source-images"] input[type=file]'
    );
    if (!el) throw new Error('file input not found');
    return el;
  });
  await userEvent.upload(
    input,
    Array.from({ length: count }, (_, i) => imageFile(`photo-${i}.jpg`))
  );
}

const loaderCount = () =>
  document.querySelectorAll('[data-testid="source-images"] .mantine-Loader-root').length;
const pending = () => uploads.filter((u) => !u.settled);
/** A url the preview <img> can load; an unloadable one makes the card remove itself. */
async function loadableImageUrl() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
  return URL.createObjectURL(blob);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Settles uploads one at a time, oldest first, letting each outcome render before the next. Stops
 * only once no new upload has started for 500ms, so a late re-upload is settled and counted too,
 * or after MAX_SETTLES, so an upload loop ends the test instead of hanging it.
 */
const MAX_SETTLES = 20;
async function settleOneByOne(outcome: 'reject' | 'resolve') {
  for (let settled = 0; settled < MAX_SETTLES; settled++) {
    const upload = pending()[0];
    if (!upload) {
      await sleep(500);
      if (!pending().length) return;
      continue;
    }
    upload.settled = true;
    if (outcome === 'reject') upload.reject(new Error(PRESIGN_ERROR));
    else upload.resolve({ url: await loadableImageUrl(), available: true });
    await sleep(100);
  }
}

describe('SourceImageUploadMultiple — failed uploads', () => {
  beforeEach(() => {
    uploads = [];
    mocks.uploadConsumerBlob.mockReset().mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          uploads.push({ resolve, reject, settled: false });
        })
    );
    mocks.getImageDimensions.mockReset().mockResolvedValue({ width: 1024, height: 1024 });
    mocks.dialogTrigger.mockReset();
  });

  test('each picked image is uploaded once when the uploads fail', async () => {
    renderWithProviders(<Harness />);
    await pickFiles(3);
    await vi.waitFor(() => expect(uploads).toHaveLength(3));

    await settleOneByOne('reject');

    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(3);
    await expect.poll(() => page.getByText(PRESIGN_ERROR).elements().length).toBe(3);
    expect(loaderCount()).toBe(0);
  });

  test('each picked image is uploaded once when the uploads succeed', async () => {
    renderWithProviders(<Harness />);
    await pickFiles(3);
    await vi.waitFor(() => expect(uploads).toHaveLength(3));

    await settleOneByOne('resolve');

    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(3);
    await expect.poll(() => page.getByText('1024 x 1024').elements().length).toBe(3);
  });

  test('an upload that throws before reaching the server ends on an error card, not a spinner', async () => {
    // The upload's own read of the picked image fails; the earlier dimension check (which passes
    // options) succeeds.
    mocks.getImageDimensions.mockImplementation(async (src: unknown, options?: unknown) => {
      if (typeof src === 'string' && !options) throw new Error('Image failed to load');
      return { width: 1024, height: 1024 };
    });
    renderWithProviders(<Harness />);
    await pickFiles(1);

    await expect.element(page.getByText('Image failed to load')).toBeVisible();
    await expect.poll(loaderCount).toBe(0);
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
  });

  test('a failed upload after cropping shows the error', async () => {
    mocks.getImageDimensions.mockResolvedValue({ width: 600, height: 2000 });
    renderWithProviders(<Harness max={1} aspectRatios={['1:1']} />);
    await pickFiles(1);

    await vi.waitFor(() => expect(mocks.dialogTrigger).toHaveBeenCalledTimes(1));
    const { onConfirm, images } = mocks.dialogTrigger.mock.calls[0][0].props;
    onConfirm([{ src: images[0].url, cropped: new Blob(['cropped'], { type: 'image/jpeg' }) }]);
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await settleOneByOne('reject');

    await expect.element(page.getByText(PRESIGN_ERROR)).toBeVisible();
    expect(loaderCount()).toBe(0);
  });

  const submitUrl = async (url: string) => {
    await userEvent.fill(page.getByPlaceholder('Add a file or provide a URL'), url);
    await userEvent.keyboard('{Enter}');
  };

  test('the same URL added again after its upload failed is uploaded once more, not looped', async () => {
    renderWithProviders(<Harness layout="url-input" />);

    await submitUrl('https://example.com/a.jpg');
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await settleOneByOne('reject');
    await expect.element(page.getByText(PRESIGN_ERROR)).toBeVisible();

    await submitUrl('https://example.com/a.jpg');
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    await settleOneByOne('reject');

    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(2);
    await expect.poll(() => page.getByText(PRESIGN_ERROR).elements().length).toBe(2);
    expect(loaderCount()).toBe(0);
  });

  test('the same URL added twice at once, uploads succeed: each card uploads once', async () => {
    renderWithProviders(<Harness layout="url-input" />);

    await submitUrl('https://example.com/a.jpg');
    await submitUrl('https://example.com/a.jpg');
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    await settleOneByOne('resolve');

    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(2);
    await expect.poll(() => page.getByText('1024 x 1024').elements().length).toBe(2);
    expect(loaderCount()).toBe(0);
  });

  test('the same URL added twice at once: each card takes its own upload outcome', async () => {
    renderWithProviders(<Harness layout="url-input" />);

    await submitUrl('https://example.com/a.jpg');
    await submitUrl('https://example.com/a.jpg');
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    uploads[0].settled = true;
    uploads[0].reject(new Error(PRESIGN_ERROR));
    await expect.element(page.getByText(PRESIGN_ERROR)).toBeVisible();
    await settleOneByOne('resolve');

    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(2);
    await expect.poll(() => page.getByText('1024 x 1024').elements().length).toBe(1);
    expect(page.getByText(PRESIGN_ERROR).elements()).toHaveLength(1);
    expect(loaderCount()).toBe(0);
  });

  test('a queued card shows the Loader and holds the generator', async () => {
    // Dimensions never resolve, so the card stays queued.
    mocks.getImageDimensions.mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<Harness />);
    await pickFiles(1);

    await expect.poll(loaderCount).toBe(1);
    // What `useImagesUploadingOrVerifying` reads to hold the cost estimate and submit.
    const { uploading, verifying } = useImagesUploadingStore.getState();
    expect(uploading.length + verifying.length).toBeGreaterThan(0);
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
  });
});
