import { builtinModules } from 'module';
import { Worker } from 'worker_threads';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { isAllocationFailure } from '~/server/services/resource-intent-cooc/store';
import { TagIndexDecodeUnavailableError } from '~/server/services/resource-intent-tags/decode-errors';
import { decodeTagIndexInWorker } from '~/server/services/resource-intent-tags/decode-worker';
import { TAG_INDEX_DECODE_WORKER_SOURCE } from '~/server/services/resource-intent-tags/decode-worker.source.generated';
import { decodeTagIndex, encodeTagIndex } from '~/server/services/resource-intent-tags/payload';
import {
  loadManifestSnapshot,
  TagIndexPayloadCorruptError,
  type TagIndexSnapshotManifest,
} from '~/server/services/resource-intent-tags/store';
import {
  bundleRequires,
  buildTagIndexDecodeWorkerModule,
} from '../../../../scripts/build-tag-index-decode-worker.mjs';
import { createHash } from 'crypto';
import { smallTagIndexData } from './resource-intent-tags.fixture';

/**
 * The tag-index decode worker: the committed bundle is what the TypeScript builds to, it can run in
 * an eval'd worker in the standalone image (Node builtins only), it decodes exactly what the
 * main-thread decoder does without running the decoder on the calling thread, and its failures keep
 * their meaning for the store.
 */
vi.setConfig({ testTimeout: 60_000 });

const SPEC = 'd'.repeat(64);
const VOCAB = 'a'.repeat(64);
const encoded = () => encodeTagIndex(smallTagIndexData(VOCAB), SPEC);

describe('decode worker bundle', () => {
  it('the committed module is exactly a fresh bundle of decode-worker.entry.ts', async () => {
    const fresh: string = await buildTagIndexDecodeWorkerModule();
    const { readFileSync } = await import('fs');
    const committed = readFileSync(
      'src/server/services/resource-intent-tags/decode-worker.source.generated.ts',
      'utf8'
    );
    // On failure: node scripts/build-tag-index-decode-worker.mjs
    expect(committed === fresh).toBe(true);
  });

  it('requires only Node builtins, so an eval worker can load it from any cwd', () => {
    const required: string[] = bundleRequires(TAG_INDEX_DECODE_WORKER_SOURCE);
    expect(required.length).toBeGreaterThan(0); // the scan sees requires at all
    const isBuiltin = (n: string) => n.startsWith('node:') || builtinModules.includes(n);
    expect(required.filter((n) => !isBuiltin(n))).toEqual([]);
    expect(bundleRequires('x = require("msgpackr"); y = require( \'he\' )')).toEqual([
      'msgpackr',
      'he',
    ]);
  });
});

describe('decodeTagIndexInWorker', () => {
  it('decodes to the same index, version and spec hash as the main-thread decoder', async () => {
    const payload = await encoded();
    const main = await decodeTagIndex(Buffer.from(payload));
    const viaWorker = await decodeTagIndexInWorker(Buffer.from(payload));
    expect(viaWorker.specHash).toBe(SPEC);
    expect(viaWorker.vocabVersion).toBe(VOCAB);
    expect(viaWorker.index).toEqual(main.index);
  });

  it('bad bytes reject with the message the main-thread decoder gives; the store calls them corrupt', async () => {
    const payload = await encoded();
    const bad = Buffer.from(payload.subarray(0, payload.length - 9));
    const mainError = await decodeTagIndex(Buffer.from(bad)).catch((e: Error) => e);
    const workerError = await decodeTagIndexInWorker(Buffer.from(bad)).catch((e: Error) => e);
    expect(workerError).toBeInstanceOf(Error);
    expect((workerError as Error).message).toBe((mainError as Error).message);
    // The error's code crosses the thread too (brotli's codes are how an allocation failure is told
    // from bad bytes); this truncation has one, so the comparison is not of two undefineds.
    const code = (e: unknown) => (e as { code?: string }).code;
    expect(code(mainError)).toBe('Z_BUF_ERROR');
    expect(code(workerError)).toBe(code(mainError));
    expect(workerError).not.toBeInstanceOf(TagIndexDecodeUnavailableError);

    const sha = createHash('sha256').update(bad).digest('hex');
    const manifest = {
      id: 'x',
      vocabVersion: VOCAB,
      specHash: SPEC,
      payloadSha256: sha,
      payloadBytes: bad.length,
      objectKey: `p/${sha}`,
    } as TagIndexSnapshotManifest;
    const sql = { query: async () => [{ status: 'frozen' }], execute: async () => 0 } as never;
    const objects = {
      prefix: 'p',
      put: async () => undefined,
      get: async () => ({ bytes: Buffer.from(bad), sha256: sha }),
    };
    await expect(
      loadManifestSnapshot({ sql, objects, decode: (b) => decodeTagIndexInWorker(b) }, manifest)
    ).rejects.toBeInstanceOf(TagIndexPayloadCorruptError);
  });
});

describe('decodeTagIndexInWorker failures through the store', () => {
  const sqlFrozen = { query: async () => [{ status: 'frozen' }], execute: async () => 0 } as never;
  async function load(
    bytes: Buffer,
    decode: (b: Uint8Array, signal?: AbortSignal) => ReturnType<typeof decodeTagIndexInWorker>
  ) {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const manifest = {
      id: 'x',
      vocabVersion: VOCAB,
      specHash: SPEC,
      payloadSha256: sha,
      payloadBytes: bytes.length,
      objectKey: `p/${sha}`,
    } as TagIndexSnapshotManifest;
    const objects = {
      prefix: 'p',
      put: async () => undefined,
      get: async () => ({ bytes: Buffer.from(bytes), sha256: sha }),
    };
    return loadManifestSnapshot({ sql: sqlFrozen, objects, decode }, manifest).then(
      () => null,
      (e: unknown) => e
    );
  }

  it('a worker that dies is not taken for bad bytes', async () => {
    const e = await load(await encoded(), (b) =>
      decodeTagIndexInWorker(b, { source: 'process.exit(1)' })
    );
    expect(e).toBeInstanceOf(TagIndexDecodeUnavailableError);
    expect(e).not.toBeInstanceOf(TagIndexPayloadCorruptError);
  });

  it('allocation failures stay retryable: a decoder failing out of heap passes the store as one, and brotli failing to allocate in the worker keeps its code', async () => {
    const oom = await load(await encoded(), async () => {
      throw Object.assign(new Error('worker heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' });
    });
    expect(oom).not.toBeInstanceOf(TagIndexPayloadCorruptError);
    expect(isAllocationFailure(oom)).toBe(true);
    const source = `
      const { parentPort } = require('worker_threads');
      parentPort.once('message', () => parentPort.postMessage({
        ok: false, error: { name: 'Error', message: 'zlib', code: 'ERR_ZLIB_INITIALIZATION_FAILED' } }));`;
    const zlibFailure = await load(await encoded(), (b) => decodeTagIndexInWorker(b, { source }));
    expect(zlibFailure).not.toBeInstanceOf(TagIndexPayloadCorruptError);
    expect(isAllocationFailure(zlibFailure)).toBe(true);
  });

  it('an abort terminates the worker and rejects as unavailable', async () => {
    let exited = false;
    let exitedBeforeReject = false;
    onTestFinished(() => terminate.mockRestore());
    const realTerminate = Worker.prototype.terminate;
    const terminate = vi
      .spyOn(Worker.prototype, 'terminate')
      .mockImplementation(function (this: Worker) {
        return realTerminate.call(this).then((code) => {
          exited = true;
          return code;
        });
      });
    const abort = new AbortController();
    const hang = `require('worker_threads').parentPort.once('message', () => setInterval(() => {}, 1000));`;
    const pending = decodeTagIndexInWorker(Buffer.from(await encoded()), {
      source: hang,
      signal: abort.signal,
    }).catch((x: unknown) => {
      exitedBeforeReject = exited;
      return x;
    });
    abort.abort();
    const e = await pending;
    expect(e).toBeInstanceOf(TagIndexDecodeUnavailableError);
    expect((e as Error).message).toMatch(/aborted/);
    expect(terminate).toHaveBeenCalledTimes(1);
    // The rejection waited for the worker to exit.
    expect(exitedBeforeReject).toBe(true);
  });
});
