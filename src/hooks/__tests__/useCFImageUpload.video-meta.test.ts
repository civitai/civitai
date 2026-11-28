import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Notifications from '~/utils/notifications';

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/utils/media-preprocessors', () => ({
  preprocessFile: vi.fn(),
  auditImageMeta: vi.fn(async () => ({ blockedFor: undefined })),
}));

import { getDataFromFile } from '~/hooks/useCFImageUpload';
import { auditImageMeta, preprocessFile } from '~/utils/media-preprocessors';

const meta = { prompt: 'a red fox', comfy: '{"prompt":{}}' };
const processed = (type: 'image' | 'video') => ({
  type,
  name: `file.${type === 'image' ? 'png' : 'mp4'}`,
  mimeType: type === 'image' ? 'image/png' : 'video/mp4',
  objectUrl: 'blob:fake',
  meta,
  metadata: { width: 64, height: 48, hash: 'LKO2', duration: 1, audio: false, size: 1 },
});

describe('getDataFromFile generation meta', () => {
  beforeEach(() => vi.clearAllMocks());

  // Video meta enters only through useMediaUpload; this path must keep dropping it.
  it('drops the meta a video preprocessed with', async () => {
    vi.mocked(preprocessFile).mockResolvedValueOnce(processed('video') as never);
    const data = await getDataFromFile(new File([], 'file.mp4'));
    expect(data).not.toBeNull();
    expect(data?.meta).toBeUndefined();
    expect(auditImageMeta).toHaveBeenCalledTimes(1);
    expect(auditImageMeta).toHaveBeenCalledWith(undefined, false);
  });

  it('keeps and audits the meta an image preprocessed with', async () => {
    vi.mocked(preprocessFile).mockResolvedValueOnce(processed('image') as never);
    const data = await getDataFromFile(new File([], 'file.png'));
    expect(data?.meta).toEqual(meta);
    expect(auditImageMeta).toHaveBeenCalledWith(meta, false);
  });

  it('rejects audio, which the image pipeline cannot upload yet', async () => {
    vi.mocked(preprocessFile).mockResolvedValueOnce({
      type: 'audio',
      name: 'song.mp3',
      mimeType: 'audio/mpeg',
      objectUrl: 'blob:fake',
      metadata: { duration: 1, size: 1 },
    } as never);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await expect(getDataFromFile(new File([], 'song.mp3'))).rejects.toThrow(/audio/i);
    expect(revoke).toHaveBeenCalledWith('blob:fake');
  });
});
