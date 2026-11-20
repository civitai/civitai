// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type * as Notifications from '~/utils/notifications';

const act = (React as unknown as { act: (callback: () => Promise<void> | void) => Promise<void> })
  .act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flags = vi.hoisted(() => ({ music: false }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useOptionalFeatureFlags: () => ({ music: flags.music }),
}));
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
vi.mock('~/utils/metadata/audit', () => ({ auditPostImageMeta: vi.fn() }));

import { useMediaUpload } from '~/hooks/useMediaUpload';
import type { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import { preprocessFile } from '~/utils/media-preprocessors';
import { showErrorNotification } from '~/utils/notifications';

const processedSong = {
  type: 'audio',
  name: 'song.mp3',
  mimeType: 'audio/mpeg',
  objectUrl: 'blob:song',
  meta: undefined,
  metadata: { duration: 200, size: 3 },
};
const audioMetadata = { title: 'Night Drive', bpm: 128 };

async function dropSong(item: Record<string, unknown>) {
  const onComplete = vi.fn<(props: MediaUploadOnCompleteProps) => void>();
  let upload!: ReturnType<typeof useMediaUpload>['upload'];
  function Harness() {
    upload = useMediaUpload({ count: 0, onComplete }).upload;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () =>
    upload([{ file: new File([], 'song.mp3', { type: 'audio/mpeg' }), ...item }] as never)
  );
  await act(async () => root.unmount());
  return onComplete;
}

describe('useMediaUpload with a generated song', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(preprocessFile).mockResolvedValue(processedSong as never);
  });

  it('uploads the song with its details merged into the audio metadata for a music user', async () => {
    flags.music = true;
    const onComplete = await dropSong({
      mediaType: 'audio',
      audioMetadata,
      meta: { prompt: 'synthwave', seed: 7 },
      generationWorkflowId: 'wf-1',
    });
    expect(preprocessFile).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ asAudio: true })
    );
    expect(uploadToS3).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({
      status: 'added',
      type: 'audio',
      generationWorkflowId: 'wf-1',
      meta: { prompt: 'synthwave', seed: 7 },
      metadata: { duration: 200, size: 3, title: 'Night Drive', bpm: 128 },
    });
  });

  it('refuses a song for a user without the music flag, without uploading it', async () => {
    flags.music = false;
    vi.mocked(preprocessFile).mockRejectedValue(new Error('Audio uploads are not supported yet.'));
    const onComplete = await dropSong({ mediaType: 'audio', audioMetadata });
    expect(preprocessFile).toHaveBeenCalledWith(
      expect.any(File),
      expect.not.objectContaining({ asAudio: true })
    );
    expect(showErrorNotification).toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('refuses a picked audio file for a music user: only the generator posts songs', async () => {
    flags.music = true;
    vi.mocked(preprocessFile).mockRejectedValue(new Error('Audio uploads are not supported yet.'));
    const onComplete = await dropSong({});
    expect(preprocessFile).toHaveBeenCalledWith(
      expect.any(File),
      expect.not.objectContaining({ asAudio: true })
    );
    expect(onComplete).not.toHaveBeenCalled();
    expect(uploadToS3).not.toHaveBeenCalled();
  });
});
