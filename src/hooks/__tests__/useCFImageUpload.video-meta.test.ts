import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));
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
    expect(auditImageMeta).toHaveBeenCalledWith(undefined, false);
  });

  it('keeps and audits the meta an image preprocessed with', async () => {
    vi.mocked(preprocessFile).mockResolvedValueOnce(processed('image') as never);
    const data = await getDataFromFile(new File([], 'file.png'));
    expect(data?.meta).toEqual(meta);
    expect(auditImageMeta).toHaveBeenCalledWith(meta, false);
  });
});
