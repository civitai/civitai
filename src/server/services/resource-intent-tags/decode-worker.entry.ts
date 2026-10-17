/**
 * The tag-index decode worker's entry. NOT imported by the app: `scripts/build-tag-index-decode-worker.mjs`
 * bundles it (with `./payload` and its imports) into `decode-worker.source.generated.ts`, which the
 * app runs with `new Worker(source, { eval: true })` (see `./decode-worker`).
 *
 * One message in, one message out: the compressed payload arrives (transferred), and the validated
 * arrays go back, every ArrayBuffer transferred rather than copied. A payload that fails to decode
 * or validate is reported with its error's name, message and code, so the caller can tell an
 * allocation failure from bad bytes the same way it does on the main thread.
 */
import { parentPort } from 'worker_threads';
import { decodeTagIndexData, transferablesOf } from './payload';

export type DecodeWorkerRequest = { payload: Uint8Array };
export type DecodeWorkerReply =
  | { ok: true; result: Awaited<ReturnType<typeof decodeTagIndexData>> }
  | { ok: false; error: { name: string; message: string; code?: string } };

const port = parentPort;
if (!port) throw new Error('decode-worker.entry must run in a worker thread');

port.once('message', (msg: DecodeWorkerRequest) => {
  decodeTagIndexData(msg.payload).then(
    (result) => {
      const reply: DecodeWorkerReply = { ok: true, result };
      port.postMessage(reply, transferablesOf(result.data));
    },
    (e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      const code = (err as { code?: unknown }).code;
      const reply: DecodeWorkerReply = {
        ok: false,
        error: {
          name: err.name,
          message: err.message,
          ...(typeof code === 'string' ? { code } : {}),
        },
      };
      port.postMessage(reply);
    }
  );
});
