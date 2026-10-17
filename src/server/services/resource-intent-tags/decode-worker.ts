import { Worker } from 'worker_threads';

import { tagFitBound } from './build';
import { TAG_INDEX_DECODE_WORKER_SOURCE } from './decode-worker.source.generated';
import type { DecodeWorkerReply, DecodeWorkerRequest } from './decode-worker.entry';
import {
  assembleTagIndexCooperative,
  TAG_INDEX_DECODE_CAPS,
  type DecodedTagIndex,
  type TagIndexDecodeCaps,
} from './payload';
import { TagIndexDecodeUnavailableError } from './decode-errors';

/**
 * Decodes a tag-index payload on a worker thread, so the synchronous unpacking and validation that
 * `decodeTagIndex` does on the caller's thread happens off the event loop. The
 * worker gets the payload's bytes (transferred: the caller's copy is detached), decompresses,
 * unpacks and validates them, and hands the arrays back transferred; only the scorer's maps are
 * built here, a slice per event-loop turn (`assembleTagIndexCooperative`). One worker per decode,
 * terminated once it has answered (its exit follows shortly after); an abort rejects only after the
 * worker has exited.
 *
 * Errors keep `decodeTagIndex`'s meaning for `store.ts`: a payload that fails to decode or validate
 * throws an error of the same name, message and code as the worker's; an allocation failure
 * (including the worker running out of heap, `ERR_WORKER_OUT_OF_MEMORY`) keeps its code, so it is
 * retried rather than taken for bad bytes; and a worker that could not start, or ended without
 * answering, throws `TagIndexDecodeUnavailableError`, which says nothing about the payload.
 */

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** An error the worker reported, rebuilt with its name, message and code. */
function rebuild(e: { name: string; message: string; code?: string }): Error {
  const err = e.name === 'RangeError' ? new RangeError(e.message) : new Error(e.message);
  if (e.name !== 'RangeError' && e.name !== 'Error') err.name = e.name;
  if (e.code !== undefined) (err as Error & { code?: string }).code = e.code;
  return err;
}

/** A transferable buffer holding exactly `bytes` (a copy only when `bytes` is a view of a larger one). */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  )
    return bytes.buffer;
  return Uint8Array.prototype.slice.call(bytes).buffer as ArrayBuffer;
}

export type DecodeWorkerOptions = {
  /** The worker's source (tests substitute a misbehaving one). */
  source?: string;
  /** Aborting terminates the worker (or stops the assembly) and rejects as unavailable. */
  signal?: AbortSignal;
  /** How assembly yields to the event loop between slices (tests observe it); a `setImmediate` turn. */
  pause?: () => Promise<void>;
  /** Units of assembly work between pauses (`ASSEMBLE_STEP_WORK` unless given). */
  assembleEvery?: number;
  /** The size caps the worker enforces: `TAG_INDEX_DECODE_CAPS` unless given. */
  caps?: TagIndexDecodeCaps;
  /** The fit bound the worker validates against: the build's `tagFitBound()` unless given. */
  fitBound?: number;
};

/** Decompress, unpack and validate `payload` on a worker thread; build the scorer's index here. */
export function decodeTagIndexInWorker(
  payload: Uint8Array,
  opts: DecodeWorkerOptions = {}
): Promise<DecodedTagIndex> {
  return new Promise<DecodedTagIndex>((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted)
      return reject(
        new TagIndexDecodeUnavailableError('tag index decode aborted before it started')
      );
    let worker: Worker;
    try {
      worker = new Worker(opts.source ?? TAG_INDEX_DECODE_WORKER_SOURCE, { eval: true });
    } catch (e) {
      reject(new TagIndexDecodeUnavailableError('tag index decode worker did not start', e));
      return;
    }
    let settled = false;
    // An abort rejects only once the worker has exited, so whoever waits on this knows the thread
    // (and the buffers it holds) is gone.
    const onAbort = () => {
      if (settled) return;
      settled = true;
      void worker
        .terminate()
        .finally(() => reject(new TagIndexDecodeUnavailableError('tag index decode aborted')));
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
      void worker.terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (reply: DecodeWorkerReply) =>
      finish(() => {
        if (!reply.ok) return reject(rebuild(reply.error));
        const { data, vocabVersion, specHash } = reply.result;
        // An abort while assembling stops it at its next pause.
        const pause = async () => {
          await (opts.pause ?? nextTurn)();
          if (signal?.aborted)
            throw new TagIndexDecodeUnavailableError('tag index decode aborted while assembling');
        };
        assembleTagIndexCooperative(data, pause, opts.assembleEvery).then(
          (index) => resolve({ index, vocabVersion, specHash }),
          reject
        );
      })
    );
    worker.once('error', (e: Error & { code?: string }) =>
      finish(() =>
        reject(
          e.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? e
            : new TagIndexDecodeUnavailableError('tag index decode worker failed', e)
        )
      )
    );
    worker.once('exit', (code) =>
      finish(() =>
        reject(
          new TagIndexDecodeUnavailableError(
            `tag index decode worker exited (code ${code}) without answering`
          )
        )
      )
    );
    try {
      const buffer = ownBuffer(payload);
      const request: DecodeWorkerRequest = {
        payload: new Uint8Array(buffer),
        caps: opts.caps ?? TAG_INDEX_DECODE_CAPS,
        fitBound: opts.fitBound ?? tagFitBound(),
      };
      worker.postMessage(request, [buffer]);
    } catch (e) {
      finish(() =>
        reject(
          new TagIndexDecodeUnavailableError('tag index decode worker was not sent the payload', e)
        )
      );
    }
  });
}
