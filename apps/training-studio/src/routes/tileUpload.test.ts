import { describe, expect, it, vi } from 'vitest';
import { UploadError } from '$lib/upload';
import type { Img } from './trainingFlow';

const uploadFile = vi.fn();
vi.mock('$lib/upload', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
}));

const { inFlight, uploadTile } = await import('./tileUpload');

const file = new File(['x'], 'a.png', { type: 'image/png' });

async function run(outcome: () => Promise<unknown>) {
  uploadFile.mockImplementationOnce(outcome);
  const patches: Partial<Img>[] = [];
  const blob = await uploadTile(file, (v) => patches.push(v), new AbortController().signal);
  return { blob, last: patches.at(-1) };
}

describe('uploadTile', () => {
  it('returns the blob without marking the tile uploaded, so a duplicate can still be dropped', async () => {
    const { blob, last } = await run(async () => ({
      id: 'b1',
      url: 'https://x/b1',
      available: true,
    }));
    expect(blob?.id).toBe('b1');
    expect(last?.status).toBe('uploading');
  });

  it('marks a content-policy rejection blocked and anything else retryable', async () => {
    const blocked = await run(() => Promise.reject(new UploadError(422, 'Refused by the scan')));
    expect(blocked.blob).toBeNull();
    expect(blocked.last).toEqual({ status: 'blocked', message: 'Refused by the scan' });
    const failed = await run(() => Promise.reject(new UploadError(0, 'Network error')));
    expect(failed.last).toEqual({ status: 'error', message: 'Network error' });
  });

  it('leaves an aborted tile alone — whoever aborted it owns it', async () => {
    const { blob, last } = await run(() =>
      Promise.reject(new DOMException('Aborted', 'AbortError'))
    );
    expect(blob).toBeNull();
    expect(last?.status).toBe('uploading');
  });
});

describe('inFlight', () => {
  it('aborts the previous request for a key, and the newer one keeps the slot', async () => {
    const requests = inFlight<string>();
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const first = requests.run('k', (signal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => (release = resolve));
    });
    const second = requests.run('k', async (signal) => {
      signals.push(signal);
      release();
      await first;
      requests.abort('k');
    });
    await second;
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(true);
  });
});
