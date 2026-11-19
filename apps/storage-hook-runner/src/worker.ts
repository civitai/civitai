import { parentPort } from 'node:worker_threads';
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
export type WorkerRequest = { id: number } & EvaluateArgs;
export type WorkerResponse =
  | ({ id: number } & EvaluateOutput)
  | { id: number; crashed: string }
  | { ready: true };

if (!parentPort) throw new Error('worker.ts must run in a worker thread');
const port = parentPort;
const instance = QuickJSInstance.fromCompiled(compileQuickJS());

port.on('message', (msg: WorkerRequest) => {
  instance.evaluate(msg).then(
    (out) =>
      port.postMessage({
        id: msg.id,
        result: out.result,
        elapsedMs: out.elapsedMs,
      } satisfies WorkerResponse),
    // Only runner faults reach here (evaluate answers every hook-caused one); the pool answers 500.
    (err: unknown) =>
      port.postMessage({ id: msg.id, crashed: String(err) } satisfies WorkerResponse)
  );
});

port.postMessage({ ready: true } satisfies WorkerResponse);
