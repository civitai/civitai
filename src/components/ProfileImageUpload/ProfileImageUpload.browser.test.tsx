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
  /**
   * ms the mocked PUT stays in flight — see the note in `uploadToCF` below.
   *
   * Comfortably wider than `vi.waitFor`'s 50 ms poll interval so the "the spinner went UP"
   * edge cannot be stepped over between polls. At 150 ms it passed 5/5 under load but had
   * only ~3 polls of margin; the window is free to widen, a missed edge is a hard failure
   * (the assertion can never become true afterwards), so buy the margin.
   */
  uploadMs: 500,
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
const preview = () => document.querySelector('[data-testid="preview"]') as HTMLImageElement | null;

/**
 * The two string shapes `value` accepts, BOTH of them.
 *
 * 🔴 `value` is typed `string | { url: string }`, and the string half has two real
 * inhabitants: a legacy absolute URL, and a bare media key — which is what `onChange`
 * emits and what `Image.url` stores, i.e. the shape a saved avatar actually round-trips
 * as. An earlier draft of the restore test used the URL alone, which is the one string
 * shape that worked: `valuePreview` gated a string on `isValidURL`, so with a bare key it
 * returned `undefined` and the restore rendered an empty circle. Fixing that meant
 * consolidating the derivation; keeping this guard honest means driving both.
 */
const EXISTING_URL = 'https://cdn.example.com/existing-avatar.png';
const EXISTING_KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const EXISTING_SHAPES: ReadonlyArray<[label: string, value: string]> = [
  ['a full url', EXISTING_URL],
  ['a bare media key', EXISTING_KEY],
];

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
    /**
     * 🔴 AND NO PREVIEW OF THE REFUSED FILE.
     *
     * The `useDidUpdate` used to set `image` from the tracked file on EVERY status,
     * `error` included, and call `onChange` only on `success`. So a refused PUT painted
     * the new avatar into the circle while the form still held the old value — the user
     * saw their new avatar plus an error line, and Save silently kept the old one. There
     * is no `value` here, so the honest render is no preview at all.
     */
    expect(preview()).toBeNull();
  });

  test.each(EXISTING_SHAPES)(
    'a refused PUT leaves the EXISTING avatar on screen when `value` is %s',
    async (_label, existing) => {
      /**
       * 🔴 THE SAME DEFECT WITH A NON-EMPTY FORM VALUE, which is the shape a real user hits.
       *
       * Two ways to be wrong and this pins both: painting `new-key` claims an upload that
       * did not happen, and painting nothing claims the avatar was removed. `onChange` never
       * fired, so the form still holds `existing` and that is what has to be on screen.
       *
       * 🔴 RUN OVER BOTH STRING SHAPES. With the bare key this went red before the
       * derivations were consolidated — preview present before the drop (the effect set
       * it), `null` after (the restore's `valuePreview` returned `undefined` for a
       * non-URL string, and the effect could not re-run because `value` never changed).
       */
      mocks.behavior = 'fail';
      const onChange = vi.fn();
      renderWithProviders(
        <ProfileImageUpload label="Avatar" value={existing} onChange={onChange} />
      );

      await vi.waitFor(() => expect(preview()?.getAttribute('src')).toBe(existing));
      await dropFile();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain('Upload failed (status 403)')
      );
      await vi.waitFor(() => expect(preview()?.getAttribute('src')).toBe(existing));
      expect(onChange).not.toHaveBeenCalled();
    }
  );

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
    // 🔴 POSITIVE CONTROL for the two `preview()` absences above: they are only meaningful
    // if this component renders a preview at all and the selector matches it.
    await vi.waitFor(() => expect(preview()?.getAttribute('src')).toBe('blob:new'));
  });
});
