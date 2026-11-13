import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FileUtils from '~/utils/file-utils';

const h = vi.hoisted(() => ({ fetchBlob: vi.fn(), pushError: vi.fn() }));

vi.mock('~/utils/file-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof FileUtils>()),
  fetchBlob: h.fetchBlob,
}));
vi.mock('@grafana/faro-web-sdk', () => ({ faro: { api: { pushError: h.pushError } } }));

import {
  mediaDropzoneData,
  orchestratorMediaTransmitter,
} from '~/store/post-image-transmitter.store';
import { MEDIA_IDLE_TIMEOUT_MS } from '~/utils/file-utils';

const OK_URL = 'https://orchestration.example.com/abc/ok.jpeg?token=secret-ok';
const BAD_URL = 'https://cdn.example.com/def/bad.jpeg?token=secret-bad';

describe('orchestratorMediaTransmitter.getFiles', () => {
  beforeEach(() => {
    h.fetchBlob.mockReset();
    h.pushError.mockReset();
  });

  it('keeps the files that loaded when one fetch fails, and counts the failure', async () => {
    h.fetchBlob.mockImplementation(async (url: string) => {
      if (url === BAD_URL) throw new TypeError('Load failed');
      return new Blob(['x'], { type: 'image/jpeg' });
    });
    orchestratorMediaTransmitter.setUrls('k', [
      { url: OK_URL, generationWorkflowId: 'wf-1' },
      { url: BAD_URL },
    ]);

    const { files, failedCount } = await orchestratorMediaTransmitter.getFiles('k');

    expect(files.map((f) => [f.file.name, f.generationWorkflowId])).toEqual([['ok.jpeg', 'wf-1']]);
    expect(failedCount).toBe(1);
    expect(h.pushError).toHaveBeenCalledTimes(1);
  });

  it('reports the error name and host, never the path or token', async () => {
    // Some browsers put the URL in a fetch error's message; it must not pass through.
    h.fetchBlob.mockRejectedValue(new DOMException(`timed out ${BAD_URL}`, 'TimeoutError'));
    orchestratorMediaTransmitter.setUrls('k', [{ url: BAD_URL }]);

    await orchestratorMediaTransmitter.getFiles('k');

    expect(h.pushError).toHaveBeenCalledTimes(1);
    const [error, opts] = h.pushError.mock.calls[0];
    expect(opts.skipDedupe).toBe(true);
    expect(opts.context).toEqual({ errorName: 'TimeoutError', host: 'cdn.example.com' });
    expect(JSON.stringify([error.message, opts])).not.toMatch(/secret|def\/bad/);
  });

  // fetchBlob returns null for a non-2xx response only when asked to with requireOk.
  it('counts a non-OK or empty response as a failure', async () => {
    h.fetchBlob.mockResolvedValue(null);
    orchestratorMediaTransmitter.setUrls('k', [{ url: OK_URL }]);

    const { files, failedCount } = await orchestratorMediaTransmitter.getFiles('k');

    expect([files.length, failedCount]).toEqual([0, 1]);
    // The generator import reads with an idle timeout, not a total cap: long videos are large.
    expect(h.fetchBlob).toHaveBeenCalledWith(OK_URL, undefined, {
      requireOk: true,
      idleTimeoutMs: MEDIA_IDLE_TIMEOUT_MS,
    });
    expect(h.pushError.mock.calls[0][1].context.errorName).toBe('NoBlob');
  });

  it('carries a song flag and its details through, and types an unmapped audio blob by extension', async () => {
    h.fetchBlob.mockResolvedValue(new Blob(['x'], { type: 'audio/x-wav' }));
    const audioMetadata = { title: 'Night Drive', bpm: 128 };
    orchestratorMediaTransmitter.setUrls('k', [
      { url: 'https://orchestration.example.com/abc/song.wav', mediaType: 'audio', audioMetadata },
    ]);

    const { files } = await orchestratorMediaTransmitter.getFiles('k');

    expect(files[0]).toMatchObject({ mediaType: 'audio', audioMetadata });
    expect(files[0].file.type).toBe('audio/vnd.wave');
  });

  it('keeps the mime of an audio blob the preprocessor already knows, and retypes nothing else', async () => {
    h.fetchBlob.mockResolvedValue(new Blob(['x'], { type: 'audio/mpeg' }));
    orchestratorMediaTransmitter.setUrls('k', [
      { url: 'https://orchestration.example.com/abc/song.wav', mediaType: 'audio' },
    ]);
    expect((await orchestratorMediaTransmitter.getFiles('k')).files[0].file.type).toBe(
      'audio/mpeg'
    );

    h.fetchBlob.mockResolvedValue(new Blob(['x'], { type: 'image/gif' }));
    orchestratorMediaTransmitter.setUrls('k', [
      { url: 'https://orchestration.example.com/abc/a.wav' },
    ]);
    expect((await orchestratorMediaTransmitter.getFiles('k')).files[0].file.type).toBe('image/gif');
  });
});

// Drag-and-drop calls getData without a catch, so a failed import must resolve, not reject.
describe('mediaDropzoneData.getData', () => {
  it('resolves undefined and reports when the fetch fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network'));
    vi.stubGlobal('fetch', fetchMock);
    h.pushError.mockReset();
    try {
      const url = 'https://orchestration.civitai.com/v2/blobs/a.mp4?sig=x';
      mediaDropzoneData.setData(url, {});

      await expect(mediaDropzoneData.getData(url)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalled();
      expect(h.pushError.mock.calls[0][1].context.errorName).toBe('TypeError');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
