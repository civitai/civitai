import { parentPort } from 'node:worker_threads';
import { evaluateRemix } from './remix.ts';
import type { RemixArgs, RemixOutput } from './remix.ts';
import { QuickJSInstance, compileQuickJS } from './sandbox.ts';
import type { EvaluateArgs, EvaluateOutput } from './sandbox.ts';

/**
 * worker_threads entry. One evaluation at a time (the pool never sends a second message before
 * the first is answered). Compiles the QuickJS WASM once and keeps one shared instance; every
 * call gets a fresh QuickJS runtime inside it, and the instance is replaced after a call that may
 * have left it unsafe (see `QuickJSInstance` in sandbox.ts).
 *
 * Loaded by Node directly (type stripping under test, the tsup bundle in production), so this
 * file and its imports use erasable TypeScript only and `.ts` import specifiers.
 */
export type WorkerJob = ({ kind: 'hook' } & EvaluateArgs) | ({ kind: 'remix' } & RemixArgs);
export type WorkerRequest = { id: number } & WorkerJob;
export type WorkerResponse =
  | ({ id: number } & EvaluateOutput)
  | { id: number; remix: RemixOutput }
  | { id: number; crashed: string }
  | { ready: true };

if (!parentPort) throw new Error('worker.ts must run in a worker thread');
const port = parentPort;
const compiled = compileQuickJS();
const instance = QuickJSInstance.fromCompiled(compiled);

// Only runner faults reach a rejection (every author-caused one is an answer); the pool answers 500.
const crashed = (id: number) => (err: unknown) =>
  port.postMessage({ id, crashed: String(err) } satisfies WorkerResponse);

port.on('message', (msg: WorkerRequest) => {
  if (msg.kind === 'remix') {
    evaluateRemix(compiled, msg)
      .then((remix) => port.postMessage({ id: msg.id, remix } satisfies WorkerResponse))
      .catch(crashed(msg.id));
    return;
  }
  instance.evaluate(msg).then(
    (out) =>
      port.postMessage({
        id: msg.id,
        result: out.result,
        elapsedMs: out.elapsedMs,
      } satisfies WorkerResponse),
    crashed(msg.id)
  );
});

port.postMessage({ ready: true } satisfies WorkerResponse);
