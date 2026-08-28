import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * `ProfileImageUpload` after a REFUSED presigned PUT.
 *
 * 🔴 THE DEFECT THIS PINS. `uploadToCF` now rejects when the store refuses the PUT
 * (403 on an expired presign, 400, 503) instead of resolving as though it had worked.
 * Two things were then wrong here, and the PR body's justification for leaving this
 * component alone — "every one of these derives its spinner from that status" — was
 * false for it:
 *
 *   1. `showLoading` was `imageFile && imageFile.progress < 100`. `progress` is written
 *      only by the `xhr.upload` progress listener; no failure branch touches it. A PUT
 *      refused before its first progress event leaves it at `0`, so the overlay latched
 *      on with no way to clear it.
 *   2. `handleDrop` was a bare `await uploadToCF(file)` inside a Mantine `onDrop`, which
 *      discards the returned promise. The rejection surfaced as an unhandled rejection
 *      and the user was told nothing at all.
 *
 * The dropzone here is never gated on `showLoading`, so a retry was always physically
 * possible — what was missing was the spinner clearing and any indication of failure.
 * (In the two sibling consumers the render IS gated, and the Dropzone unmounts.)
 */

const mocks = vi.hoisted(() => ({
  behavior: 'success' as 'success' | 'fail' | 'hang',
  /** ms the mocked PUT stays in flight — see the note in `uploadToCF` below. */
  uploadMs: 150,
  uploaded: { url: 'new-key', objectUrl: 'blob:new', id: 'new-key', type: 'image' },
}));

/**
 * Real hook SHAPE, driven per test. `files` is genuine React state so the component's
 * `useDidUpdate([imageFile])` fires exactly as it does against the real hook.
 *
 * 🔴 The failure branch reproduces the real hook's state precisely: `status: 'error'`
 * with `progress` left at **0**. That combination is the whole bug — a fake that set
 * `progress: 100` on failure would encode the same wrong assumption the old code made
 * and pass with the defect present.
 */
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
          setFiles([{ ...mocks.uploaded, status: 'uploading', progress: 0 }]);
          if (mocks.behavior === 'hang') return new Promise(() => undefined);
          /**
           * 🔴 A REAL, OBSERVABLE IN-FLIGHT WINDOW, not a microtask.
           *
           * `vi.waitFor(() => expect(x).toBeNull())` is satisfied by the state BEFORE
           * anything happened, so a test that only waits for the spinner to vanish
           * passes against a component that never showed one. Measured: with a
           * `setTimeout(0)` here, the `progress < 100` mutant SURVIVED that assertion.
           * The delay makes "it went up, then it came down" a sequence the test can
           * actually observe.
           */
          await new Promise((r) => setTimeout(r, mocks.uploadMs));
          if (mocks.behavior === 'fail') {
            setFiles([{ ...mocks.uploaded, status: 'error', progress: 0 }]);
            throw new Error('Upload failed (status 403)');
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

import { ProfileImageUpload } from '~/components/ProfileImageUpload/ProfileImageUpload';

const overlay = () => document.querySelector('.mantine-LoadingOverlay-root');

async function dropFile() {
  await expect
    .poll(() => document.querySelector('input[type="file"]'), {
      message: 'the dropzone file input should mount',
    })
    .not.toBeNull();

  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const transfer = new DataTransfer();
  transfer.items.add(new File(['x'], 'avatar.png', { type: 'image/png' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('ProfileImageUpload — a refused PUT', () => {
  let unhandled: unknown[] = [];
  const record = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
    event.preventDefault();
  };

  beforeEach(() => {
    mocks.behavior = 'success';
    unhandled = [];
    window.addEventListener('unhandledrejection', record);
  });

  afterEach(() => {
    window.removeEventListener('unhandledrejection', record);
  });

  test('POSITIVE CONTROL: the spinner IS shown while the upload is in flight', async () => {
    /**
     * 🔴 Without this, "the spinner cleared" is satisfied by a component that never
     * renders a spinner at all, and by a selector that matches nothing. This case pins
     * the selector against an upload that never settles, so it cannot race.
     */
    mocks.behavior = 'hang';
    renderWithProviders(<ProfileImageUpload label="Avatar" />);

    await dropFile();
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
  });

  test('the spinner CLEARS when the upload errors with progress still at 0', async () => {
    // 🔴 THE REGRESSION. `progress` is 0 here and stays 0, so the replaced
    // `imageFile.progress < 100` is true forever and the overlay never came down.
    mocks.behavior = 'fail';
    renderWithProviders(<ProfileImageUpload label="Avatar" />);

    await dropFile();
    // 🔴 BOTH EDGES, IN ORDER. Waiting only for the overlay to be null is vacuous: it is
    // already null before the drop is processed, which is exactly how the
    // `progress < 100` mutant survived an earlier draft of this test.
    await vi.waitFor(() => expect(overlay()).not.toBeNull());
    await vi.waitFor(() => expect(overlay()).toBeNull());
  });

  test('the failure is SURFACED to the user instead of vanishing', async () => {
    mocks.behavior = 'fail';
    renderWithProviders(<ProfileImageUpload label="Avatar" />);

    await dropFile();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Upload failed (status 403)')
    );
  });

  test('the refused PUT does not produce an unhandled rejection', async () => {
    mocks.behavior = 'fail';
    renderWithProviders(<ProfileImageUpload label="Avatar" />);

    await dropFile();
    // Wait past the mocked in-flight window plus a margin, rather than on a DOM
    // condition: an unhandled rejection is reported asynchronously and is not visible in
    // the tree at all, so there is nothing to poll for.
    await new Promise((r) => setTimeout(r, mocks.uploadMs + 250));
    expect(unhandled).toEqual([]);
  });

  test('a SUCCESSFUL upload still clears the spinner and emits the new key', async () => {
    // The invariant half: the fix must not have been "never show a spinner".
    mocks.behavior = 'success';
    const onChange = vi.fn();
    renderWithProviders(<ProfileImageUpload label="Avatar" onChange={onChange} />);

    await dropFile();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ url: 'new-key' }));
    await vi.waitFor(() => expect(overlay()).toBeNull());
    expect(document.body.textContent).not.toContain('Upload failed');
  });
});
