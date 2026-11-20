import { describe, expect, test, vi, beforeEach } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * `SimpleImageUpload`'s value-preservation contract.
 *
 * The widget used to call `handleRemove()` — which fires `onChange(null)` — the instant
 * a file was dropped, while `onChange` only fires again once the upload reaches
 * `status === 'success'`. Any form saved in that window, or after a failed upload,
 * persisted "no image" and destroyed whatever was there. For the announcement banner
 * that means the sitewide banner disappears; the same shape applies to every consumer
 * that keeps the dropzone mounted alongside a value (`previewDisabled`).
 *
 * These tests pin: a drop never clears the value, a FAILED upload never clears the value
 * and leaves the widget usable again, a SUCCESSFUL upload emits the new key, and an
 * explicit remove still clears (the one case that legitimately should).
 */

const mocks = vi.hoisted(() => ({
  behavior: 'success' as 'success' | 'fail' | 'hang',
  uploaded: { url: 'new-key', objectUrl: 'blob:new', id: 'new-key', type: 'image' },
}));

// Real hook shape, driven per-test. `files` is genuine React state so the component's
// `useDidUpdate([imageFile])` fires exactly as it does against the real hook.
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
            // Mirrors the real hook: the tracked file is left below 100% progress.
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

// Not under test, and the real one resolves a delivery URL through client-only hooks.
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => <img alt="preview" data-testid="preview" src={src} />,
}));
vi.mock('~/utils/application-error', () => ({ reportApplicationError: vi.fn() }));

import { isImageOwner, SimpleImageUpload } from '~/libs/form/components/SimpleImageUpload';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { imageStore } from '~/store/image.store';
import { FixedSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';

const EXISTING_KEY = 'existing-banner-key';

/**
 * Drop a file on the mounted dropzone.
 *
 * React commits asynchronously, so the input has to be polled for. The file is then set
 * on the input directly rather than through `userEvent.upload`: the dropzone's input is
 * visually hidden, and the userEvent helper resolves elements through a visible-role
 * locator that cannot address it. Assigning `files` + dispatching `change` is exactly
 * what the browser does on a real pick/drop, and is what react-dropzone listens for.
 */
async function dropFile() {
  await expect
    .poll(() => document.querySelector('input[type="file"]'), {
      message: 'the dropzone file input should mount',
    })
    .not.toBeNull();

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const transfer = new DataTransfer();
  transfer.items.add(new File(['x'], 'banner.png', { type: 'image/png' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('SimpleImageUpload value preservation', () => {
  beforeEach(() => {
    mocks.behavior = 'success';
  });

  test('an in-flight upload never clears the existing value', async () => {
    mocks.behavior = 'hang';
    const onChange = vi.fn();
    const onUploadStateChange = vi.fn();

    renderWithProviders(
      <SimpleImageUpload
        label="Banner"
        value={EXISTING_KEY}
        previewDisabled
        withNsfwLevel={false}
        onChange={onChange}
        onUploadStateChange={onUploadStateChange}
      />
    );

    await dropFile();
    await vi.waitFor(() => expect(onUploadStateChange).toHaveBeenCalledWith('uploading'));

    // 🔴 The regression: `onChange(null)` here is what a mid-upload save persisted.
    expect(onChange).not.toHaveBeenCalled();
  });

  test('a failed upload never clears the existing value and leaves the widget usable', async () => {
    mocks.behavior = 'fail';
    const onChange = vi.fn();
    const onUploadStateChange = vi.fn();

    renderWithProviders(
      <SimpleImageUpload
        label="Banner"
        value={EXISTING_KEY}
        previewDisabled
        withNsfwLevel={false}
        onChange={onChange}
        onUploadStateChange={onUploadStateChange}
      />
    );

    await dropFile();
    await vi.waitFor(() => expect(onUploadStateChange).toHaveBeenCalledWith('error'));

    expect(onChange).not.toHaveBeenCalled();
    // The loading overlay used to be driven by `progress < 100`, which a failed upload
    // never reaches — pinning the overlay on forever with no way to retry.
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });

  test('uploading and failing are reported as distinct states, in order', async () => {
    mocks.behavior = 'fail';
    const onUploadStateChange = vi.fn();

    renderWithProviders(
      <SimpleImageUpload
        label="Banner"
        previewDisabled
        withNsfwLevel={false}
        onUploadStateChange={onUploadStateChange}
      />
    );

    await dropFile();
    await vi.waitFor(() => expect(onUploadStateChange).toHaveBeenCalledWith('error'));

    const states = onUploadStateChange.mock.calls.map(([s]) => s);
    expect(states.indexOf('uploading')).toBeGreaterThanOrEqual(0);
    expect(states.indexOf('error')).toBeGreaterThan(states.indexOf('uploading'));
  });

  test('a successful upload replaces the value with the new key and settles to idle', async () => {
    mocks.behavior = 'success';
    const onChange = vi.fn();
    const onUploadStateChange = vi.fn();

    renderWithProviders(
      <SimpleImageUpload
        label="Banner"
        value={EXISTING_KEY}
        previewDisabled
        withNsfwLevel={false}
        onChange={onChange}
        onUploadStateChange={onUploadStateChange}
      />
    );

    await dropFile();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ url: 'new-key' }));
    // Never a null in between — the parent form only ever sees old key -> new key.
    expect(onChange.mock.calls.every(([v]) => v !== null)).toBe(true);
    await vi.waitFor(() => expect(onUploadStateChange.mock.calls.at(-1)?.[0]).toBe('idle'));
  });

  test('an explicit remove still clears the value', async () => {
    // The one path that SHOULD emit null. Without a preview there is no remove control,
    // so this renders the default (preview-enabled) variant.
    const onChange = vi.fn();

    renderWithProviders(
      <SimpleImageUpload
        label="Banner"
        value={EXISTING_KEY}
        withNsfwLevel={false}
        onChange={onChange}
      />
    );

    await expect
      .poll(() => document.querySelector('button'), {
        message: 'the remove control should render next to the preview',
      })
      .not.toBeNull();
    (document.querySelector('button') as HTMLElement).click();

    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe('SimpleImageUpload rating badge', () => {
  const saved = { id: 42, nsfwLevel: 4, userId: 7, url: 'saved-key' };
  const changeRating = () => document.querySelector('button[aria-label="Change rating"]');
  const badgeShown = () =>
    expect.poll(() => document.querySelector('.mantine-Badge-root')).not.toBeNull();
  const asOwner = (ui: React.ReactElement) => (
    <FixedSessionProvider user={{ id: 7 }}>{ui}</FixedSessionProvider>
  );

  beforeEach(() => useDialogStore.getState().closeAll());

  test('a saved image opens the rating vote for that image when ratingClickable', async () => {
    await renderWithProviders(
      asOwner(<SimpleImageUpload label="Cover" value={saved} ratingClickable />)
    );

    await expect.poll(changeRating).not.toBeNull();
    (changeRating() as HTMLElement).click();

    const [dialog] = useDialogStore.getState().dialogs;
    expect(dialog?.props).toEqual({ imageId: 42, nsfwLevel: 4, isOwner: true });
  });

  test('a vote recorded in the image store updates the badge and the next vote', async () => {
    await renderWithProviders(
      asOwner(<SimpleImageUpload label="Cover" value={{ ...saved, id: 43 }} ratingClickable />)
    );
    await expect.poll(changeRating).not.toBeNull();

    imageStore.setImage(43, { nsfwLevel: 8 });
    await expect.poll(() => changeRating()?.textContent).toBe('X');
    (changeRating() as HTMLElement).click();

    expect(useDialogStore.getState().dialogs[0]?.props).toMatchObject({
      imageId: 43,
      nsfwLevel: 8,
    });
  });

  test('stays read-only without ratingClickable, for an unsaved image, or when disabled', async () => {
    const screen = await renderWithProviders(
      asOwner(<SimpleImageUpload label="Cover" value={saved} />)
    );
    await badgeShown();
    expect(changeRating()).toBeNull();

    await screen.rerender(
      asOwner(
        <SimpleImageUpload label="Cover" value={{ ...saved, id: undefined }} ratingClickable />
      )
    );
    await badgeShown();
    expect(changeRating()).toBeNull();

    await screen.rerender(
      asOwner(<SimpleImageUpload label="Cover" value={saved} ratingClickable disabled />)
    );
    await badgeShown();
    expect(changeRating()).toBeNull();
  });
  test.each([
    [{ userId: 7 }, 7, true],
    [{ user: { id: 7 } }, 7, true],
    [{ userId: 7, user: { id: 8 } }, 7, true],
    [{ userId: 8 }, 7, false],
    [{ user: { id: 8 } }, 7, false],
    [{}, 7, false],
    [{ userId: 7 }, undefined, false],
  ])('isImageOwner(%j, viewer %s) is %s', (image, viewer, expected) => {
    expect(isImageOwner(viewer, image)).toBe(expected);
  });
});
