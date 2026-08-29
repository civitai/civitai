import { describe, expect, test, vi } from 'vitest';
import {
  BULK_PANEL_FALLBACK_DIMENSIONS,
  uploadBulkPanels,
} from '~/components/Comics/bulk-panel-upload';

/**
 * `PanelModal`'s bulk panel drop, after a REFUSED presigned PUT part-way through a batch.
 *
 * 🔴 THE CLAIM THIS PINS, which round 2 flagged as reviewed-by-reading only: a refused PUT
 * on file 2 of N must NOT abandon files 3..N. The handler used to wrap the whole loop in
 * one `try`, so the first rejection left the loop and every later file was silently never
 * attempted, under a single `Failed to upload image` toast naming no file and no count.
 * `character.tsx`'s identically-shaped reference loop got the opposite remedy in the same
 * round (per-file `catch` + `continue`). Two shapes, one question, two answers.
 *
 * Lives in the `component` (real Chromium) project rather than the node `unit` one because
 * the loop reads each file's natural size through `window.Image` + `URL.createObjectURL`.
 * Running it in a real browser keeps that half of the code under test instead of stubbing
 * the thing that decides each panel's dimensions.
 *
 * `uploadToCF` is the only injected dependency, and it is injected because it is a React
 * hook's method — the metadata reader and the edge-url builder are the production imports.
 */

/** A real, decodable 2x2 PNG, so `readDimensions` resolves rather than falling back. */
const PNG_2X2 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
);

const png = (name: string) => new File([PNG_2X2 as BlobPart], name, { type: 'image/png' });

describe('uploadBulkPanels — one refused PUT must not end the batch', () => {
  test('the first file lands, the second is refused, and the THIRD is still attempted', async () => {
    /**
     * 🔴 THREE files, not two, and the assertion is on the third.
     *
     * With two files a "stops on failure" implementation and a "continues" one are
     * indistinguishable when the failure is last, and nearly so when it is first. Failing
     * the MIDDLE one makes the difference observable: a stopping loop calls `uploadToCF`
     * twice and returns one item; a continuing loop calls it three times and returns two.
     */
    const uploadToCF = vi
      .fn<(file: File) => Promise<{ id: string }>>()
      .mockResolvedValueOnce({ id: 'key-one' })
      .mockRejectedValueOnce(new Error('Upload failed (status 403)'))
      .mockResolvedValueOnce({ id: 'key-three' });

    const { items, failed } = await uploadBulkPanels({
      files: [png('a.png'), png('b.png'), png('c.png')],
      uploadToCF,
    });

    expect(uploadToCF).toHaveBeenCalledTimes(3);
    expect(items.map((item) => item.sourceImage?.cfId)).toEqual(['key-one', 'key-three']);
    expect(failed).toEqual([
      { name: 'b.png', error: expect.objectContaining({ message: 'Upload failed (status 403)' }) },
    ]);
  });

  test('it REPORTS the failure rather than swallowing it', async () => {
    // The mirror of the case above: continuing must not mean "pretend nothing happened".
    // `failed` is what the handler turns into the notification, so an empty `failed` on a
    // refused PUT is the silent-failure bug wearing a different hat.
    const uploadToCF = vi
      .fn<(file: File) => Promise<{ id: string }>>()
      .mockRejectedValue(new Error('Upload failed (status 503)'));

    const { items, failed } = await uploadBulkPanels({
      files: [png('only.png')],
      uploadToCF,
    });

    expect(items).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe('only.png');
    expect(failed[0].error.message).toBe('Upload failed (status 503)');
  });

  test('POSITIVE CONTROL: a clean batch produces a panel per file and no failures', async () => {
    /**
     * 🔴 Without this, every assertion above is satisfiable by a loop that returns nothing
     * and reports everything as failed. It also pins that the real `window.Image` decode
     * ran: a 2x2 PNG must come back as 2x2, NOT as the 512x512 fallback — so a change that
     * broke dimension reading would show up here rather than shipping panels sized wrong.
     */
    const uploadToCF = vi
      .fn<(file: File) => Promise<{ id: string }>>()
      .mockImplementation(async (file) => ({ id: `key-${file.name}` }));

    const { items, failed } = await uploadBulkPanels({
      files: [png('a.png'), png('b.png')],
      uploadToCF,
    });

    expect(failed).toEqual([]);
    expect(items).toHaveLength(2);
    expect(items[0].sourceImage).toMatchObject({ cfId: 'key-a.png', width: 2, height: 2 });
    expect(items[0].sourceImage?.width).not.toBe(BULK_PANEL_FALLBACK_DIMENSIONS.width);
    expect(items[1].sourceImage).toMatchObject({ cfId: 'key-b.png' });
  });

  test('an UNDECODABLE file still uploads, at the fallback size', async () => {
    // Pre-existing behaviour, pinned so the `continue` above cannot be widened into
    // "skip anything that is not a valid image". The dimension read fails; the upload does
    // not, so the panel is still worth creating.
    const uploadToCF = vi
      .fn<(file: File) => Promise<{ id: string }>>()
      .mockResolvedValue({ id: 'key-junk' });

    const { items, failed } = await uploadBulkPanels({
      files: [new File(['not an image'], 'junk.png', { type: 'image/png' })],
      uploadToCF,
    });

    expect(failed).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0].sourceImage).toMatchObject({
      cfId: 'key-junk',
      width: BULK_PANEL_FALLBACK_DIMENSIONS.width,
      height: BULK_PANEL_FALLBACK_DIMENSIONS.height,
    });
  });

  test('a throw from OUTSIDE the upload call keeps the panels that already landed', async () => {
    /**
     * 🔴 THE INVARIANT `PanelModal` USED TO HOLD IN A `finally`, NOW HELD HERE.
     *
     * The handler assigns its `landed` only once `uploadBulkPanels` has returned as a
     * whole, so anything that escapes this loop discards every panel that already uploaded
     * — uploads the user watched succeed. The per-file `try` therefore spans the whole loop
     * body, not just `uploadToCF`.
     *
     * Driven through a REAL escape hatch rather than an invented one: `readDimensions`
     * calls `URL.createObjectURL` outside every `try` in that helper, so a synchronous
     * throw from it rejects the awaited promise. Stubbing it for exactly one file's name
     * reproduces that without touching the module under test.
     *
     * The failure is on the FIRST of three files on purpose — `items` is empty at that
     * point, so the case also pins that a wide `try` does not simply mean "swallow": the
     * loop must go on to upload b and c and must report a.
     */
    const realCreateObjectURL = URL.createObjectURL.bind(URL);
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((blob: Blob | MediaSource) => {
        if ((blob as File).name === 'a.png') throw new Error('createObjectURL refused a.png');
        return realCreateObjectURL(blob);
      });

    try {
      const uploadToCF = vi
        .fn<(file: File) => Promise<{ id: string }>>()
        .mockImplementation(async (file) => ({ id: `key-${file.name}` }));

      const { items, failed } = await uploadBulkPanels({
        files: [png('a.png'), png('b.png'), png('c.png')],
        uploadToCF,
      }).catch((err: unknown) => {
        // The mutant's signature. `uploadBulkPanels` returns partials by contract; when it
        // throws instead, the caller's `landed` stays `[]` and b + c are lost silently.
        throw new Error(
          'uploadBulkPanels must not throw on a mid-loop failure — the panels that already ' +
            `uploaded are discarded when it does. It threw: ${(err as Error).message}`
        );
      });

      // b and c still uploaded, and their panels came back.
      expect(uploadToCF).toHaveBeenCalledTimes(2);
      expect(items.map((item) => item.sourceImage?.cfId)).toEqual(['key-b.png', 'key-c.png']);

      // …and a was REPORTED, not silently dropped.
      expect(failed).toEqual([
        {
          name: 'a.png',
          error: expect.objectContaining({ message: 'createObjectURL refused a.png' }),
        },
      ]);
    } finally {
      createObjectURL.mockRestore();
    }
  });
});
