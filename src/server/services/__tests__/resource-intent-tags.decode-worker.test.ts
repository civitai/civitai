import { builtinModules } from 'module';
import { MessageChannel, receiveMessageOnPort, Worker } from 'worker_threads';
import { Packr, Unpackr } from 'msgpackr';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { isAllocationFailure } from '~/server/services/resource-intent-cooc/store';
import { TagIndexDecodeUnavailableError } from '~/server/services/resource-intent-tags/decode-errors';
import { decodeTagIndexInWorker } from '~/server/services/resource-intent-tags/decode-worker';
import { TAG_INDEX_DECODE_WORKER_SOURCE } from '~/server/services/resource-intent-tags/decode-worker.source.generated';
import {
  assembleTagIndex,
  assembleTagIndexCooperative,
  compressTagIndex,
  decodeTagIndex,
  decompressTagIndex,
  decodeTagIndexData,
  encodeTagIndex,
  TAG_INDEX_MAX_INFLATED_BYTES,
  TAG_INDEX_MAX_PAYLOAD_BYTES,
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
  FORBIDDEN_INPUTS,
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

  it('holds the decoder alone: no build.ts (its tunable constants) and no msgpack packer', () => {
    const inputs = [...TAG_INDEX_DECODE_WORKER_SOURCE.matchAll(/^\/\/ (\S+\.(?:ts|js))$/gm)].map(
      (m) => m[1]
    );
    // Positive control: the scan finds the bundle's inputs at all.
    expect(inputs).toContain('src/server/services/resource-intent-tags/payload-decode.ts');
    expect(
      inputs.filter((i) => /resource-intent-tags\/build\.ts$|msgpackr\/pack\.js$/.test(i))
    ).toEqual([]);
    // The generator's refusal pattern matches build.ts (the packer cannot be reached at all:
    // `msgpackr` resolves to its unpacker in the bundle).
    expect(
      FORBIDDEN_INPUTS.map((re: RegExp) =>
        re.test('src/server/services/resource-intent-tags/build.ts')
      )
    ).toEqual([true]);
  });

  it('the generator refuses a bundle that pulls in build.ts', async () => {
    await expect(
      buildTagIndexDecodeWorkerModule({
        entrySource: "import { tagFitBound } from './build'; console.log(tagFitBound());",
      })
    ).rejects.toThrow(/forbidden inputs: .*resource-intent-tags\/build\.ts/);
    // Control: an entry that needs only the decoder builds.
    await expect(
      buildTagIndexDecodeWorkerModule({
        entrySource: "import { single } from './payload-decode'; console.log(single(1));",
      })
    ).resolves.toMatch(/TAG_INDEX_DECODE_WORKER_SOURCE/);
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
      expect((unpack.mock.calls[0][0] as Uint8Array).length).toBeGreaterThan(1);
    } finally {
      unpack.mockRestore();
    }
  });

  it("enforces the caps it is handed by the main thread, not its bundle's copy", async () => {
    const payload = await encoded();
    const small = await decodeTagIndexInWorker(Buffer.from(payload), {
      caps: { maxPayloadBytes: 10, maxInflatedBytes: TAG_INDEX_MAX_INFLATED_BYTES },
    }).catch((e: Error) => e);
    expect((small as Error).message).toBe(`tag index payload ${payload.length} bytes exceeds 10`);
    const inflate = await decodeTagIndexInWorker(Buffer.from(payload), {
      caps: { maxPayloadBytes: TAG_INDEX_MAX_PAYLOAD_BYTES, maxInflatedBytes: 100 },
    }).catch((e: Error) => e);
    expect((inflate as Error & { code?: string }).code).toBe('ERR_BUFFER_TOO_LARGE');
  });

  it("validates against the fit bound the main thread hands it, not a constant of the bundle's", async () => {
    const payload = await encoded();
    // The fixture's fits are within tagFitBound() (2); a bound below them refuses the same bytes.
    expect((await decodeTagIndexInWorker(Buffer.from(payload))).specHash).toBe(SPEC);
    const tight = await decodeTagIndexInWorker(Buffer.from(payload), { fitBound: 1e-6 }).catch(
      (e: Error) => e
    );
    expect((tight as Error).message).toMatch(/fit out of range/);
    // A bound that is not a positive number is refused rather than validated against nothing.
    for (const fitBound of [NaN, 0, -1])
      expect(
        (
          (await decodeTagIndexInWorker(Buffer.from(payload), { fitBound }).catch(
            (e: Error) => e
          )) as Error
        ).message
      ).toBe(`tag index decode: fit bound ${fitBound} is not a positive number`);
  });

  it("without a fit bound given, hands the worker the build's tagFitBound()", async () => {
    // A fit of 3 is past tagFitBound() (2) and within any looser bound: the encoder does not
    // check fits, so the worker's validation is what refuses it.
    const data = smallTagIndexData(VOCAB);
    data.kinds.addon.fit[0] = 3;
    const payload = await encodeTagIndex(data, SPEC);
    const e = await decodeTagIndexInWorker(Buffer.from(payload)).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/addon fit out of range/);
    // Control: the same bytes under a bound above 3 decode.
    expect((await decodeTagIndexInWorker(Buffer.from(payload), { fitBound: 4 })).specHash).toBe(
      SPEC
    );
  });

  it("without caps given, hands the worker the exported caps (not the bundle's own)", async () => {
    // The worker's error message names the cap it enforced; a payload one byte over the exported
    // cap must be refused with exactly that cap.
    const over = new Uint8Array(TAG_INDEX_MAX_PAYLOAD_BYTES + 1);
    const e = await decodeTagIndexInWorker(over).catch((x: Error) => x);
    expect((e as Error).message).toBe(
      `tag index payload ${
        TAG_INDEX_MAX_PAYLOAD_BYTES + 1
      } bytes exceeds ${TAG_INDEX_MAX_PAYLOAD_BYTES}`
    );
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

  it('a payload that decompresses and unpacks but fails validation is refused in the worker, as corrupt', async () => {
    const packr = new Packr({ useRecords: false, mapsAsObjects: true });
    const doc = packr.unpack(await decompressTagIndex(await encoded())) as Record<string, number>;
    doc.rowsWithEcosystem += 1;
    const invalid = await compressTagIndex(packr.pack(doc));
    const e = await load(invalid, (b) => decodeTagIndexInWorker(b));
    expect(e).toBeInstanceOf(TagIndexPayloadCorruptError);
    expect((e as Error).message).toMatch(/ecosystem observations do not sum/);
  });

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

  it('a worker that answers but would stay alive is terminated', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    onTestFinished(() => terminate.mockRestore());
    const lingering = `
      const { parentPort } = require('worker_threads');
      setInterval(() => {}, 1000);
      parentPort.once('message', () => parentPort.postMessage({
        ok: false, error: { name: 'Error', message: 'refused' } }));`;
    const e = await decodeTagIndexInWorker(new Uint8Array(4), { source: lingering }).catch(
      (x: unknown) => x
    );
    expect((e as Error).message).toBe('refused');
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('an abort while the arrays are being assembled stops the assembly', async () => {
    const abort = new AbortController();
    const e = await decodeTagIndexInWorker(Buffer.from(await encoded()), {
      signal: abort.signal,
      pause: async () => abort.abort(),
      assembleEvery: 3,
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TagIndexDecodeUnavailableError);
    expect((e as Error).message).toMatch(/aborted while assembling/);
  });

  it('a signal already aborted rejects before any worker starts', async () => {
    const abort = new AbortController();
    abort.abort();
    const e = await decodeTagIndexInWorker(Buffer.from(await encoded()), {
      signal: abort.signal,
      source: `throw new Error('a worker was started')`,
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TagIndexDecodeUnavailableError);
    expect((e as Error).message).toMatch(/aborted before it started/);
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
