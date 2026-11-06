import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FileUtils from '~/utils/file-utils';

const h = vi.hoisted(() => ({ fetchBlob: vi.fn(), pushError: vi.fn() }));

vi.mock('~/utils/file-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof FileUtils>()),
  fetchBlob: h.fetchBlob,
}));
vi.mock('@grafana/faro-web-sdk', () => ({ faro: { api: { pushError: h.pushError } } }));

import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';

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
    expect(h.fetchBlob).toHaveBeenCalledWith(OK_URL, undefined, { requireOk: true });
    expect(h.pushError.mock.calls[0][1].context.errorName).toBe('NoBlob');
  });
});
