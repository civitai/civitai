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
  useS3Upload: () => ({
    files: [],
    uploadToS3,
    resetFiles: vi.fn(),
    removeFile: vi.fn(),
  }),
}));
vi.mock('~/utils/media-preprocessors', () => ({ preprocessFile: vi.fn() }));
vi.mock('~/utils/metadata/audit', () => ({ auditMetaData: vi.fn() }));

import { useMediaUpload } from '~/hooks/useMediaUpload';
import type { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import { preprocessFile } from '~/utils/media-preprocessors';
import { auditMetaData } from '~/utils/metadata/audit';

const videoMeta = { prompt: 'a prompt the audit rejects', engine: 'ComfyUI' };
const processedVideo = {
  type: 'video',
  name: 'clip.mp4',
  mimeType: 'video/mp4',
  objectUrl: 'blob:clip',
  meta: videoMeta,
  metadata: { width: 64, height: 48, hash: 'LKO2', duration: 1, audio: false, size: 1 },
};

async function dropVideo(fileMeta?: Record<string, unknown>) {
  const onComplete = vi.fn<(props: MediaUploadOnCompleteProps) => void>();
  let upload!: ReturnType<typeof useMediaUpload>['upload'];
  function Harness() {
    upload = useMediaUpload({ count: 0, onComplete }).upload;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () =>
    upload([{ file: new File([], 'clip.mp4', { type: 'video/mp4' }), meta: fileMeta }])
  );
  await act(async () => root.unmount());
  return onComplete;
}

describe('useMediaUpload with a video carrying generation meta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(preprocessFile).mockResolvedValue(processedVideo as never);
  });

  it('audits the video meta and reports the file blocked, without uploading it', async () => {
    vi.mocked(auditMetaData).mockResolvedValue({
      blockedFor: ['audit-reason'],
      success: false,
    } as never);
    const onComplete = await dropVideo();
    expect(auditMetaData).toHaveBeenCalledWith(expect.objectContaining(videoMeta), false);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({
      status: 'blocked',
      blockedFor: 'audit-reason',
    });
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('uploads the video with its meta when the audit passes', async () => {
    vi.mocked(auditMetaData).mockResolvedValue({ blockedFor: [], success: true } as never);
    const onComplete = await dropVideo();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ status: 'added', meta: videoMeta });
    expect(uploadToS3).toHaveBeenCalledTimes(1);
  });
});

describe('useMediaUpload with an on-site generated video', () => {
  const generatorMeta = {
    prompt: 'the prompt the user typed',
    steps: 20,
    civitaiResources: [{ modelVersionId: 3216500 }],
  };
  const workerTags = {
    Model: '/mnt/resources/Default/urn:air:minimaxh3:diffusionmodel:civitai:2821932@3216500',
    engine: 'ComfyUI',
    comfy: '{"prompt":{}}',
    prompt: 'the worker expanded prompt',
    steps: 60,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(preprocessFile).mockResolvedValue({ ...processedVideo, meta: workerTags } as never);
    vi.mocked(auditMetaData).mockResolvedValue({ blockedFor: [], success: true } as never);
  });

  it("keeps the generator's meta and drops the file's embedded ComfyUI meta", async () => {
    const onComplete = await dropVideo(generatorMeta);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ status: 'added' });
    expect(onComplete.mock.calls[0][0].meta).toEqual(generatorMeta);
    expect(auditMetaData).not.toHaveBeenCalled();
  });

  it('still reads embedded meta from a video posted without generator meta', async () => {
    const onComplete = await dropVideo();
    expect(onComplete.mock.calls[0][0].meta).toEqual(workerTags);
    expect(auditMetaData).toHaveBeenCalledWith(workerTags, false);
  });
});
