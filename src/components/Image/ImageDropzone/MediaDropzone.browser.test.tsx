import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { chooseFiles, makeUnreadableFilesFail } from '../../../../test/unreadable-files';
import type * as ApplicationError from '~/utils/application-error';

/**
 * The post editor (and every other MediaDropzone) must not hand on a file the photo picker made
 * unreadable: some Android photo pickers return a File whose every read rejects with
 * NotReadableError, while the same photo chosen from the Files app reads fine. The user is offered
 * the Files chooser instead (a file input with no image-only `accept`), and each such pick is
 * reported once with bounded fields.
 */

const mocks = vi.hoisted(() => ({ reportApplicationError: vi.fn() }));

vi.mock('~/utils/application-error', async (orig) => ({
  ...(await orig<typeof ApplicationError>()),
  reportApplicationError: mocks.reportApplicationError,
}));

// eslint-disable-next-line import/first
import { MediaDropzone } from '~/components/Image/ImageDropzone/MediaDropzone';
// eslint-disable-next-line import/first
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';

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
        'picked-file image/jpeg <5MB NotReadableError',
      ],
    ]);
  });

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

  test("files chosen from Files keep the dropzone's size and count limits", async () => {
    renderDropzone({ maxSize: 100, maxFiles: 1 });
    await chooseFiles(dropzoneInput(), [imageFile('unreadable-0.jpg')]);
    await expectFilesFallbackOffered();

    const tooLarge = new File([new Uint8Array(101)], 'big.jpg', { type: 'image/jpeg' });
    await chooseFiles(filesFallbackInput(), [
      tooLarge,
      imageFile('photo-0.jpg'),
      imageFile('photo-1.jpg'),
    ]);
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
