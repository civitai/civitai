import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import {
  chooseFiles,
  makeFilesExpireAfterFirstRead,
  makeSlowFilesStall,
  makeUnreadableFilesFail,
} from '../../../../test/unreadable-files';
import type * as ApplicationError from '~/utils/application-error';
import type * as DeviceHelpers from '~/utils/device-helpers';
import type * as TransmitterStore from '~/store/post-image-transmitter.store';

/**
 * The post editor (and every other MediaDropzone) must not hand on a file the photo picker made
 * unreadable: some Android photo pickers return a File whose every read rejects with
 * NotReadableError, while the same photo chosen from the Files app reads fine. On Android the user
 * is offered the Files chooser instead (a file input with no image-only `accept`), and each such pick is
 * reported once with bounded fields.
 */

const mocks = vi.hoisted(() => ({
  reportApplicationError: vi.fn(),
  getDropData: vi.fn(),
  /** Android unless a test says otherwise: the Files fallback is offered only there. */
  android: true,
}));

vi.mock('~/utils/device-helpers', async (orig) => ({
  ...(await orig<typeof DeviceHelpers>()),
  isAndroidDevice: () => mocks.android,
}));

vi.mock('~/store/post-image-transmitter.store', async (orig) => ({
  ...(await orig<typeof TransmitterStore>()),
  mediaDropzoneData: { getData: mocks.getDropData, setData: vi.fn(), getAllData: vi.fn() },
}));

vi.mock('~/utils/application-error', async (orig) => ({
  ...(await orig<typeof ApplicationError>()),
  reportApplicationError: mocks.reportApplicationError,
}));

// eslint-disable-next-line import/first
import { MediaDropzone } from '~/components/Image/ImageDropzone/MediaDropzone';
// eslint-disable-next-line import/first
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
// eslint-disable-next-line import/first
import { isPickSnapshot, UNREADABLE_PROBE_TIMEOUT_MS } from '~/utils/unreadable-pick';

const PICK_MESSAGE =
  "Your phone's photo picker gave us a file we can't open. Choose it from Files instead.";

const imageFile = (name: string) =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });

function dropzoneInput() {
  return vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="media"] input[type=file]:not([data-testid="unreadable-pick-files-input"])'
    );
    if (!input) throw new Error('dropzone input not found');
    return input;
  });
}

function filesFallbackInput() {
  const input = document.querySelector<HTMLInputElement>(
    '[data-testid="unreadable-pick-files-input"]'
  );
  if (!input) throw new Error('Files fallback input not found');
  return input;
}

const reports = () =>
  mocks.reportApplicationError.mock.calls.map(([error, ctx]) => [
    (error as Error).message,
    (ctx as { name?: string; message?: string } | undefined)?.name,
    (ctx as { name?: string; message?: string } | undefined)?.message,
  ]);

describe('MediaDropzone — a pick the photo picker made unreadable', () => {
  let restoreReads = () => undefined as void;
  const onDrop = vi.fn();

  beforeEach(() => {
    onDrop.mockReset();
    mocks.android = true;
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
    restoreReads = makeUnreadableFilesFail();
  });
  afterEach(() => restoreReads());

  let setLoading: (loading: boolean) => void = () => undefined;
  function Harness(props: { maxSize?: number; maxFiles?: number }) {
    const [loading, setLoadingState] = useState(false);
    setLoading = setLoadingState;
    return (
      <div data-testid="media">
        <MediaDropzone
          onDrop={onDrop}
          accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
          loading={loading}
          {...props}
        />
      </div>
    );
  }
  function renderDropzone(props: { maxSize?: number; maxFiles?: number } = {}) {
    renderWithProviders(<Harness {...props} />);
  }

  async function expectFilesFallbackOffered() {
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Choose from Files' })).toBeVisible();
    const input = filesFallbackInput();
    expect(input.type).toBe('file');
    expect(input.hasAttribute('accept')).toBe(false);
  }

  test('is not handed on, offers the Files chooser, and is reported once', async () => {
    renderDropzone();
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);

    await expectFilesFallbackOffered();
    expect(onDrop).not.toHaveBeenCalled();
    expect(reports()).toEqual([
      [
        'media pick failed: pick-unreadable',
        'media-pick',
        'picked-file image/jpeg <5MB NotReadableError android:true',
      ],
    ]);
  });

  test('off Android: a neutral message, no Files chooser, and still reported', async () => {
    mocks.android = false;
    renderDropzone();
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);

    await expect
      .element(
        page.getByText("We couldn't open this file. Try choosing it again.", { exact: true })
      )
      .toBeVisible();
    expect(page.getByRole('button', { name: 'Choose from Files' }).elements()).toHaveLength(0);
    expect(document.querySelector('[data-testid="unreadable-pick-files-input"]')).toBeNull();
    expect(page.getByText(PICK_MESSAGE).elements()).toHaveLength(0);
    expect(onDrop).not.toHaveBeenCalled();
    expect(reports()).toEqual([
      [
        'media pick failed: pick-unreadable',
        'media-pick',
        'picked-file image/jpeg <5MB NotReadableError android:false',
      ],
    ]);
  });

  test(
    'a pick whose read stalls is handed on once the probe gives up',
    async () => {
      restoreReads();
      restoreReads = makeSlowFilesStall();
      renderDropzone();
      await chooseFiles(dropzoneInput(), [imageFile('slow-0.jpg')]);
      expect(onDrop).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1), {
        timeout: UNREADABLE_PROBE_TIMEOUT_MS + 3_000,
      });
      expect(onDrop.mock.calls[0][0].map(({ file }: { file: File }) => file.name)).toEqual([
        'slow-0.jpg',
      ]);
      expect(reports()).toEqual([]);
    },
    UNREADABLE_PROBE_TIMEOUT_MS + 10_000
  );

  test('alongside a readable pick: only the readable one is handed on', async () => {
    renderDropzone();
    await chooseFiles(dropzoneInput(), [imageFile('photo-0.jpg'), imageFile('unreadable-1.jpg')]);

    await expectFilesFallbackOffered();
    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect(onDrop.mock.calls[0][0].map(({ file }: { file: File }) => file.name)).toEqual([
      'photo-0.jpg',
    ]);
    expect(reports()).toHaveLength(1);
  });

  test('a file chosen from Files is handed on and the message goes', async () => {
    renderDropzone();
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    await chooseFiles(filesFallbackInput(), [imageFile('photo-0.jpg')]);
    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect(onDrop.mock.calls[0][0].map(({ file }: { file: File }) => file.name)).toEqual([
      'photo-0.jpg',
    ]);
    await expect.poll(() => page.getByText(PICK_MESSAGE).elements().length).toBe(0);
  });

  test('a file of a type the dropzone does not accept, chosen from Files, is refused', async () => {
    renderDropzone();
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    await chooseFiles(filesFallbackInput(), [new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    await expect
      .element(page.getByText("That file type isn't supported here.", { exact: true }))
      .toBeVisible();
    expect(onDrop).not.toHaveBeenCalled();
    // The fallback stays, so the user can choose again.
    await expectFilesFallbackOffered();
  });

  test('a selection from Files mixing an image with another type is refused whole', async () => {
    renderDropzone();
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    await chooseFiles(filesFallbackInput(), [
      imageFile('photo-0.jpg'),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    ]);
    // Not even the image is handed on (checked first: a hand-on would clear the alert and its error).
    await new Promise((r) => setTimeout(r, 300));
    expect(onDrop).not.toHaveBeenCalled();
    await expect
      .element(page.getByText("That file type isn't supported here.", { exact: true }))
      .toBeVisible();
    await expectFilesFallbackOffered();
  });

  test('the Files button is disabled while the dropzone is loading', async () => {
    renderDropzone();
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    setLoading(true);
    await expect.element(page.getByRole('button', { name: 'Choose from Files' })).toBeDisabled();
    setLoading(false);
    await expect.element(page.getByRole('button', { name: 'Choose from Files' })).toBeEnabled();
  });

  test("a selection from Files over the dropzone's size limit is refused, and the fallback stays", async () => {
    renderDropzone({ maxSize: 100 });
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    const tooLarge = new File([new Uint8Array(101)], 'big.jpg', { type: 'image/jpeg' });
    await chooseFiles(filesFallbackInput(), [tooLarge, imageFile('photo-0.jpg')]);
    // The fallback stays (checked first: a cleared alert takes its error text with it).
    await new Promise((r) => setTimeout(r, 300));
    await expectFilesFallbackOffered();
    await expect
      .element(page.getByText('Files should not exceed 100 B.', { exact: true }))
      .toBeVisible();
    expect(onDrop).not.toHaveBeenCalled();
  });

  test("files chosen from Files keep the dropzone's count limit", async () => {
    renderDropzone({ maxFiles: 1 });
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    await chooseFiles(filesFallbackInput(), [imageFile('photo-0.jpg'), imageFile('photo-1.jpg')]);
    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect(onDrop.mock.calls[0][0].map(({ file }: { file: File }) => file.name)).toEqual([
      'photo-0.jpg',
    ]);
  });

  // Control: the same pick, readable, goes straight through with nothing shown or reported.
  test('a readable pick is handed on with no message and no report', async () => {
    renderDropzone();
    await chooseFiles(dropzoneInput(), [imageFile('photo-0.jpg')]);

    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect(page.getByText(PICK_MESSAGE).elements()).toHaveLength(0);
    expect(reports()).toEqual([]);
  });
});

/**
 * A photo-picker File can read fine at the pick and turn unreadable seconds later, so an image is
 * handed on as an in-memory copy taken at the pick. A dropped file the consumer later fails to read
 * gets the same fallback as an unreadable pick.
 */
describe('MediaDropzone — a picked file that turns unreadable after the pick', () => {
  const onDrop = vi.fn();
  let expiry: ReturnType<typeof makeFilesExpireAfterFirstRead> | undefined;

  beforeEach(() => {
    onDrop.mockReset();
    mocks.android = true;
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    expiry?.restore();
    expiry = undefined;
  });

  test('an image is handed on as a copy that still reads after the original stops reading', async () => {
    expiry = makeFilesExpireAfterFirstRead();
    const photo = expiry.expiringFile(
      new File(['photo bytes'], 'photo-0.jpg', { type: 'image/jpeg' })
    );
    renderWithProviders(
      <div data-testid="media">
        <MediaDropzone onDrop={onDrop} accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]} />
      </div>
    );
    await chooseFiles(dropzoneInput(), [photo]);

    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    const [{ file }] = onDrop.mock.calls[0][0] as { file: File }[];
    expect([file.name, file.type]).toEqual(['photo-0.jpg', 'image/jpeg']);
    // The consumer gets the copy itself, which is how the post editor tells it from the device's own.
    expect(isPickSnapshot(file)).toBe(true);
    expect(await file.text()).toBe('photo bytes');
    expect(reports()).toEqual([]);
  });

  test('files the consumer could not read are offered the Files fallback, which hands on new ones', async () => {
    renderWithProviders(
      <div data-testid="media">
        <MediaDropzone onDrop={onDrop} accept={IMAGE_MIME_TYPE} unreadablePicks={1} />
      </div>
    );

    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    await chooseFiles(filesFallbackInput(), [imageFile('photo-1.jpg')]);
    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect(onDrop.mock.calls[0][0].map(({ file }: { file: File }) => file.name)).toEqual([
      'photo-1.jpg',
    ]);
  });
});

/** Only as many files as the consumer can take are read: each one read is copied into memory. */
describe('MediaDropzone — a pick over the limit', () => {
  const onDrop = vi.fn();
  beforeEach(() => {
    onDrop.mockReset();
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
  });

  test('only the files within pickLimit are read and handed on', async () => {
    const files = [0, 1, 2].map((i) => imageFile(`photo-${i}.jpg`));
    const fullReads = files.map((file) => vi.spyOn(file, 'arrayBuffer'));
    renderWithProviders(
      <div data-testid="media">
        <MediaDropzone onDrop={onDrop} accept={IMAGE_MIME_TYPE} pickLimit={2} />
      </div>
    );
    await chooseFiles(dropzoneInput(), files);

    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect(onDrop.mock.calls[0][0].map(({ file }: { file: File }) => file.name)).toEqual([
      'photo-0.jpg',
      'photo-1.jpg',
    ]);
    expect(fullReads.map((read) => read.mock.calls.length)).toEqual([1, 1, 0]);
  });

  test('with no room left, nothing is read or handed on', async () => {
    const file = imageFile('photo-0.jpg');
    const fullRead = vi.spyOn(file, 'arrayBuffer');
    renderWithProviders(
      <div data-testid="media">
        <MediaDropzone onDrop={onDrop} accept={IMAGE_MIME_TYPE} pickLimit={0} />
      </div>
    );
    await chooseFiles(dropzoneInput(), [file]);
    await new Promise((r) => setTimeout(r, 300));
    expect(onDrop).not.toHaveBeenCalled();
    expect(fullRead).not.toHaveBeenCalled();
  });
});

/** A url dropped on the dropzone is fetched into memory: it is no device file a picker can revoke. */
describe('MediaDropzone — a dropped url', () => {
  const onDrop = vi.fn();
  beforeEach(() => {
    onDrop.mockReset();
    mocks.getDropData.mockReset();
  });

  test('is handed on marked as held in memory', async () => {
    const fetched = new File(['bytes'], 'image.jpeg', { type: 'image/jpeg' });
    mocks.getDropData.mockResolvedValue({ file: fetched, data: { prompt: 'x' } });
    renderWithProviders(
      <div data-testid="media">
        <MediaDropzone onDrop={onDrop} accept={IMAGE_MIME_TYPE} />
      </div>
    );
    const zone = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-testid="media"] .mantine-Dropzone-root'
      );
      if (!el) throw new Error('dropzone not found');
      return el;
    });
    const transfer = new DataTransfer();
    transfer.setData('text/uri-list', 'https://example.test/image.jpeg');
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));

    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    const [{ file, meta }] = onDrop.mock.calls[0][0] as { file: File; meta: unknown }[];
    expect(file).toBe(fetched);
    expect(meta).toEqual({ prompt: 'x' });
    expect(isPickSnapshot(file)).toBe(true);
  });
});
