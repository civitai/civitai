import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * Does the image-only editor configuration (`media` without `video`) actually
 * upload a pasted image, or does the `blob:` URL reach the sanitizer — which
 * strips the `blob:` scheme and leaves a src-less `<img>`?
 *
 * `InsertImageControlLegacy` doesn't upload anything itself, but it inserts an
 * `image` node, and `CustomImage`'s node view is what performs the upload. This
 * pins that wiring.
 */

const uploadToCF = vi.fn(async (file?: File) => ({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  objectUrl: 'blob:stub',
  name: file?.name ?? '(no file)',
}));

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({ uploadToCF, files: [], removeImage: vi.fn(), resetFiles: vi.fn() }),
}));

// The image node view calls useEdgeUrl → useCurrentUser → useCivitaiSessionContext,
// which throws without a provider. Same mock the AppBlocks suites use.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const { RichTextEditor } = await import('~/components/RichTextEditor/RichTextEditorComponent');

function pngFile() {
  // Only the mime type matters: handlePaste filters on it, and the upload itself
  // is mocked, so the bytes just need to be a non-empty blob.
  const pngMagic = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return new File([pngMagic], 'shot.png', { type: 'image/png' });
}

beforeEach(() => uploadToCF.mockClear());

describe('image-only editor (media without video)', () => {
  test('uploads a pasted image instead of persisting the blob: url', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <RichTextEditor
        value=""
        onChange={onChange}
        includeControls={['formatting', 'media'] as never}
      />
    );

    const editor = await vi.waitFor(() => {
      const node = document.querySelector<HTMLElement>('.ProseMirror');
      if (!node) throw new Error('editor not mounted');
      return node;
    });

    const data = new DataTransfer();
    data.items.add(pngFile());
    editor.focus();
    editor.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    );

    // The node view's effect performs the upload once mounted.
    await vi.waitFor(() => {
      if (!uploadToCF.mock.calls.length) throw new Error('uploadToCF not called yet');
    });

    // It must receive the real file, not an empty call.
    const uploaded = uploadToCF.mock.calls.at(-1)?.[0];
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded?.name).toBe('shot.png');

    // …and swaps the attribute to the CDN url, so no blob: survives to save.
    await vi.waitFor(() => {
      const html = onChange.mock.calls.at(-1)?.[0] as string | undefined;
      if (!html || html.includes('blob:')) throw new Error('still holding a blob url');
      expect(html).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });
  });
});
