import { builtinModules } from 'module';
import { MessageChannel, receiveMessageOnPort } from 'worker_threads';
import { Unpackr } from 'msgpackr';
import { describe, expect, it, vi } from 'vitest';
import { isAllocationFailure } from '~/server/services/resource-intent-cooc/store';
import { TagIndexDecodeUnavailableError } from '~/server/services/resource-intent-tags/decode-errors';
import { decodeTagIndexInWorker } from '~/server/services/resource-intent-tags/decode-worker';
import { TAG_INDEX_DECODE_WORKER_SOURCE } from '~/server/services/resource-intent-tags/decode-worker.source.generated';
import {
  assembleTagIndex,
  assembleTagIndexCooperative,
  decodeTagIndex,
  decodeTagIndexData,
  encodeTagIndex,
  transferablesOf,
} from '~/server/services/resource-intent-tags/payload';
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

  it('does not unpack the payload on the calling thread', async () => {
    const payload = await encoded();
    // payload.ts's msgpack decoder is a Packr, whose unpack is Unpackr.prototype's; the worker has
    // its own bundled copy, which this spy cannot see.
    const unpack = vi.spyOn(Unpackr.prototype, 'unpack');
    try {
      await decodeTagIndexInWorker(Buffer.from(payload));
      expect(unpack).not.toHaveBeenCalled();
      // Positive control: the same spy sees the main-thread decoder unpack.
      await decodeTagIndex(Buffer.from(payload));
      expect(unpack).toHaveBeenCalledTimes(1);
    } finally {
      unpack.mockRestore();
    }
  });

  it('takes the payload buffer (transferred, not copied)', async () => {
    const payload = Buffer.from(await encoded());
    const own = new Uint8Array(payload.length);
    own.set(payload);
    await decodeTagIndexInWorker(own);
    expect(own.byteLength).toBe(0);
  });

  it('bad bytes reject with the message the main-thread decoder gives; the store calls them corrupt', async () => {
    const payload = await encoded();
    const bad = Buffer.from(payload.subarray(0, payload.length - 9));
    const mainError = await decodeTagIndex(Buffer.from(bad)).catch((e: Error) => e);
    const workerError = await decodeTagIndexInWorker(Buffer.from(bad)).catch((e: Error) => e);
    expect(workerError).toBeInstanceOf(Error);
    expect((workerError as Error).message).toBe((mainError as Error).message);
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

  it('an allocation failure the worker reports stays an allocation failure', async () => {
    const source = `
      const { parentPort } = require('worker_threads');
      parentPort.once('message', () => parentPort.postMessage({
        ok: false, error: { name: 'RangeError', message: 'Array buffer allocation failed' } }));`;
    const e = await decodeTagIndexInWorker(new Uint8Array(4), { source }).catch((x) => x);
    expect(isAllocationFailure(e)).toBe(true);
  });

  it('a worker that ends without answering, or cannot start, is unavailable, not corrupt', async () => {
    const exits = await decodeTagIndexInWorker(new Uint8Array(4), {
      source: `process.exit(3)`,
    }).catch((x) => x);
    expect(exits).toBeInstanceOf(TagIndexDecodeUnavailableError);
    expect((exits as Error).message).toMatch(/exited \(code 3\)/);
    const throws = await decodeTagIndexInWorker(new Uint8Array(4), {
      source: `throw new Error('boom')`,
    }).catch((x) => x);
    expect(throws).toBeInstanceOf(TagIndexDecodeUnavailableError);
    expect((throws as Error).message).toMatch(/boom/);
  });
});

describe('payload helpers the worker relies on', () => {
  it('transferablesOf lists every buffer under the data: after a transfer, every array is detached', async () => {
    const { data } = await decodeTagIndexData(await encoded());
    const { port1, port2 } = new MessageChannel();
    const list = transferablesOf(data);
    expect(list.length).toBeGreaterThan(10);
    port1.postMessage(data, list);
    const views: ArrayBufferView[] = [];
    const walk = (v: unknown) => {
      if (ArrayBuffer.isView(v)) views.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(data);
    expect(views.length).toBeGreaterThan(10);
    expect(views.filter((v) => v.byteLength !== 0)).toEqual([]);
    expect(receiveMessageOnPort(port2)).toBeDefined();
    port1.close();
  });

  it('cooperative assembly builds the same index as assembleTagIndex, pausing as it goes', async () => {
    const { data } = await decodeTagIndexData(await encoded());
    let pauses = 0;
    const cooperative = await assembleTagIndexCooperative(
      data,
      async () => {
        pauses++;
      },
      3
    );
    expect(pauses).toBeGreaterThan(5);
    expect(cooperative).toEqual(assembleTagIndex(data));
  });
});
