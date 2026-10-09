// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type * as Notifications from '~/utils/notifications';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/components/FileUpload/FileUploadProvider', () => ({
  useFileUploadContext: () => undefined,
}));
vi.mock('~/components/MediaUploadSettings/MediaUploadSettingsProvider', () => ({
  useMediaUploadSettingsContext: () => ({
    maxItems: 10,
    maxVideoDuration: 600,
    maxVideoDimensions: 4096,
  }),
}));
const { uploadToS3 } = vi.hoisted(() => ({
  uploadToS3: vi.fn(async () => ({ key: 'uploaded-key', url: 'https://uploaded' })),
}));
vi.mock('~/hooks/useS3Upload', () => ({
  useS3Upload: () => ({ files: [], uploadToS3, resetFiles: vi.fn(), removeFile: vi.fn() }),
}));
vi.mock('~/utils/media-preprocessors', () => ({ preprocessFile: vi.fn() }));
vi.mock('~/utils/metadata/audit', () => ({ auditMetaData: vi.fn() }));

import { useMediaUpload } from '~/hooks/useMediaUpload';
import { preprocessFile } from '~/utils/media-preprocessors';
import { showErrorNotification } from '~/utils/notifications';

/**
 * A dropped file can turn unreadable after the pick (some Android photo pickers), so preparing it
 * fails with a read error. A caller that shows such files as unreadable picks takes them instead of
 * the generic error notification.
 */
async function dropFailingWith(error: unknown, onUnreadable?: (file: File) => boolean) {
  vi.mocked(preprocessFile).mockRejectedValue(error);
  const onComplete = vi.fn();
  let upload!: ReturnType<typeof useMediaUpload>['upload'];
  function Harness() {
    upload = useMediaUpload({ count: 0, onComplete, onUnreadable }).upload;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Harness)));
  const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
  await act(async () => upload([{ file }]));
  await act(async () => root.unmount());
  return { file, onComplete };
}

const imageLoadError = () =>
  new Error('Image failed to load (complete=true, naturalWidth=0)', { cause: new Event('error') });

describe('useMediaUpload with a file it cannot read', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['an <img> load error', imageLoadError()],
    ['a NotReadableError', new DOMException('x', 'NotReadableError')],
  ])('%s goes to onUnreadable, with no notification and no upload', async (_, error) => {
    const onUnreadable = vi.fn(() => true);
    const { file, onComplete } = await dropFailingWith(error, onUnreadable);
    expect(onUnreadable).toHaveBeenCalledWith(file);
    expect(showErrorNotification).not.toHaveBeenCalled();
    expect(uploadToS3).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('is notified as before when onUnreadable does not take it', async () => {
    await dropFailingWith(imageLoadError(), () => false);
    expect(showErrorNotification).toHaveBeenCalledTimes(1);
  });

  it('is notified as before with no onUnreadable', async () => {
    await dropFailingWith(imageLoadError());
    expect(showErrorNotification).toHaveBeenCalledTimes(1);
  });

  it('another failure is notified and not offered to onUnreadable', async () => {
    const onUnreadable = vi.fn(() => true);
    await dropFailingWith(new Error('Animated WebP files are not supported.'), onUnreadable);
    expect(onUnreadable).not.toHaveBeenCalled();
    expect(showErrorNotification).toHaveBeenCalledTimes(1);
  });
});
