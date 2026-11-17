import type { Readable } from 'stream';
import { describe, expect, it, vi } from 'vitest';

/**
 * The archive is streamed straight into the bucket. These pin the two properties the job relies on:
 * the build resolves only after the upload has completed (the row flips to built after it), and an
 * upload that fails mid-archive makes the build reject rather than hang.
 */

const upload = vi.hoisted(() => ({
  /** What the next Upload does once it has read this many bytes: 'complete' or a failure. */
  behaviour: { failAfterBytes: Infinity, doneDelayMs: 0 },
  completed: false,
  bytes: 0,
  aborted: 0,
  params: {} as Record<string, unknown>,
}));

vi.mock('@aws-sdk/lib-storage', async (importOriginal) => {
  const FakeUpload = class {
    private body: Readable;
    constructor(opts: { params: { Body: Readable } & Record<string, unknown> }) {
      this.body = opts.params.Body;
      upload.params = opts.params;
      upload.aborted = 0;
      upload.completed = false;
      upload.bytes = 0;
    }
    async done() {
      for await (const chunk of this.body) {
        upload.bytes += (chunk as Buffer).length;
        if (upload.bytes > upload.behaviour.failAfterBytes) throw new Error('upload failed');
      }
      await new Promise((r) => setTimeout(r, upload.behaviour.doneDelayMs));
      upload.completed = true;
      return { ETag: 'x' };
    }
    async abort() {
      upload.aborted++;
    }
  };
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, default: { ...original, Upload: FakeUpload }, Upload: FakeUpload };
});

import { streamArchiveToBucket } from '../archive';

const bucket = { client: {} as never, Bucket: 'b' };

/** Incompressible text, so the zip is about as large as its input. */
async function* noise(lines: number) {
  for (let i = 0; i < lines; i++)
    yield `${Math.random().toString(36)}${Math.random().toString(36)}\n`;
}

describe('streamArchiveToBucket', () => {
  it('resolves only after the upload has completed', async () => {
    upload.behaviour = { failAfterBytes: Infinity, doneDelayMs: 50 };
    await streamArchiveToBucket(bucket, 'k', async (w) => {
      await w.addFile('README.txt', 'hello');
      await w.addFile('data/a.csv', noise(1000));
    });
    expect(upload.completed).toBe(true);
    expect(upload.bytes).toBeGreaterThan(10_000);
    expect(upload.params).toMatchObject({ Bucket: 'b', Key: 'k', ContentType: 'application/zip' });
    expect(upload.aborted).toBe(0);
  });

  it('rejects, and does not hang, when the upload fails mid-archive', async () => {
    upload.behaviour = { failAfterBytes: 64 * 1024, doneDelayMs: 0 };
    let appended = 0;
    await expect(
      streamArchiveToBucket(bucket, 'k', async (w) => {
        for (let i = 0; i < 50; i++) {
          await w.addFile(`data/${i}.csv`, noise(2000));
          appended++;
        }
      })
    ).rejects.toThrow('upload failed');
    expect(upload.completed).toBe(false);
    expect(upload.aborted).toBe(1);
    expect(appended).toBeLessThan(50);
  });

  it('rejects when a source fails, and the upload never completes', async () => {
    upload.behaviour = { failAfterBytes: Infinity, doneDelayMs: 0 };
    async function* broken() {
      yield 'a,b\r\n';
      throw new Error('source failed');
    }
    await expect(
      streamArchiveToBucket(bucket, 'k', async (w) => {
        await w.addFile('data/x.csv', broken());
      })
    ).rejects.toThrow('source failed');
    expect(upload.completed).toBe(false);
    expect(upload.aborted).toBe(1);
  });
});
