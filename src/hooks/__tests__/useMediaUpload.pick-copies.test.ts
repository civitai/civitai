// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type * as Notifications from '~/utils/notifications';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A dropped image reaches useMediaUpload as an in-memory copy taken at the pick (MediaDropzone).
 * Its preview url holds that copy, so the url is released once the upload has landed; and each drop
 * of the same picked File is a new copy, so the duplicate-upload guard keys on the picked File.
 */

const mocks = vi.hoisted(() => {
  type Tracked = { file: File; status: string };
  /** The upload context's tracked files, mutated in place as the provider's state would be. */
  const tracked: Tracked[] = [];
  const setTracked = (update: (prev: Tracked[]) => Tracked[]) => {
    const next = update(tracked);
    tracked.splice(0, tracked.length, ...next);
  };
  return { tracked, setTracked, uploadToS3: vi.fn() };
});

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/components/FileUpload/FileUploadProvider', () => ({
  useFileUploadContext: () => [mocks.tracked, mocks.setTracked],
}));
vi.mock('~/components/MediaUploadSettings/MediaUploadSettingsProvider', () => ({
  useMediaUploadSettingsContext: () => ({
    maxItems: 10,
    maxVideoDuration: 600,
    maxVideoDimensions: 4096,
  }),
}));
vi.mock('~/hooks/useS3Upload', () => ({
  useS3Upload: () => ({
    files: [],
    uploadToS3: mocks.uploadToS3,
    resetFiles: vi.fn(),
    removeFile: vi.fn(),
  }),
}));
vi.mock('~/utils/media-preprocessors', () => ({ preprocessFile: vi.fn() }));
vi.mock('~/utils/metadata/audit', () => ({ auditMetaData: vi.fn() }));

import { useMediaUpload } from '~/hooks/useMediaUpload';
import { preprocessFile } from '~/utils/media-preprocessors';
import { showErrorNotification } from '~/utils/notifications';
import { snapshotPick } from '~/utils/unreadable-pick';

let objectUrls = 0;
function preprocessed(file: File) {
  return {
    type: 'image' as const,
    name: file.name,
    mimeType: file.type,
    objectUrl: `blob:preview-${++objectUrls}`,
    metadata: { size: file.size, width: 10, height: 10, hash: '' },
    meta: undefined,
  };
}

async function renderHook(props: Partial<Parameters<typeof useMediaUpload>[0]> = {}) {
  const onComplete = vi.fn();
  let upload!: ReturnType<typeof useMediaUpload>['upload'];
  function Harness() {
    upload = useMediaUpload({ count: 0, onComplete, ...props }).upload;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Harness)));
  return { onComplete, upload: (...args: Parameters<typeof upload>) => upload(...args), root };
}

const copyOf = async (file: File) => (await snapshotPick(file, { maxBytes: 1024 })).file!;

describe('useMediaUpload — pick-time copies', () => {
  let revoke: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tracked.splice(0);
    vi.mocked(preprocessFile).mockImplementation(async (file) => preprocessed(file));
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => revoke.mockRestore());

  it('releases the preview url of a file once its upload has landed, not before', async () => {
    let land!: (v: { key: string; url: string }) => void;
    mocks.uploadToS3.mockImplementation(() => new Promise((r) => (land = r)));
    const { upload, onComplete, root } = await renderHook();
    await act(async () => upload([{ file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) }]));
    const { objectUrl } = await vi.mocked(preprocessFile).mock.results[0].value;
    expect(revoke).not.toHaveBeenCalledWith(objectUrl);

    await act(async () => land({ key: 'k', url: 'https://uploaded/k' }));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'added' }),
      undefined
    );
    expect(revoke).toHaveBeenCalledWith(objectUrl);
    await act(async () => root.unmount());
  });

  it('keeps the preview url of a failed upload, which the error card shows', async () => {
    mocks.uploadToS3.mockRejectedValue(new Error('upload failed'));
    const { upload, onComplete, root } = await renderHook();
    await act(async () => upload([{ file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) }]));
    const { objectUrl } = await vi.mocked(preprocessFile).mock.results[0].value;
    await vi.waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error', url: objectUrl }),
        undefined
      )
    );
    expect(revoke).not.toHaveBeenCalledWith(objectUrl);
    await act(async () => root.unmount());
  });

  it('a second drop of the same picked File, copied again, is not uploaded twice', async () => {
    mocks.uploadToS3.mockImplementation(() => new Promise(() => undefined));
    const { upload, root } = await renderHook();
    const picked = new File(['photo'], 'p.jpg', { type: 'image/jpeg' });
    await act(async () => upload([{ file: await copyOf(picked) }]));
    await act(async () => upload([{ file: await copyOf(picked) }]));
    expect(mocks.uploadToS3).toHaveBeenCalledTimes(1);
    // The dropped duplicate's preview is released with it.
    const second = await vi.mocked(preprocessFile).mock.results[1].value;
    expect(revoke).toHaveBeenCalledWith(second.objectUrl);
    await act(async () => root.unmount());
  });

  it('two different picked Files with the same bytes are both uploaded', async () => {
    mocks.uploadToS3.mockImplementation(() => new Promise(() => undefined));
    const { upload, root } = await renderHook();
    const a = new File(['photo'], 'p.jpg', { type: 'image/jpeg', lastModified: 1 });
    const b = new File(['photo'], 'p.jpg', { type: 'image/jpeg', lastModified: 1 });
    await act(async () => upload([{ file: await copyOf(a) }]));
    await act(async () => upload([{ file: await copyOf(b) }]));
    expect(mocks.uploadToS3).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it('a TypeError that is not a failed read is notified, not offered as an unreadable pick', async () => {
    vi.mocked(preprocessFile).mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'width')")
    );
    const onUnreadable = vi.fn(() => true);
    const { upload, root } = await renderHook({ onUnreadable });
    await act(async () => upload([{ file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) }]));
    expect(onUnreadable).not.toHaveBeenCalled();
    expect(showErrorNotification).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
