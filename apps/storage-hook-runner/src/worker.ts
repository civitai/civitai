import { parentPort } from 'node:worker_threads';
import { compileQuickJS, evaluateHook } from './sandbox.ts';
import type { EvaluateArgs, EvaluateOutput } from './sandbox.ts';

/**
 * worker_threads entry. One evaluation at a time (the pool never sends a second message before
 * the first is answered). Compiles the QuickJS WASM once; every call gets a fresh instance.
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
const compiled = compileQuickJS();

port.on('message', (msg: WorkerRequest) => {
  evaluateHook(compiled, msg).then(
    (out) => port.postMessage({ id: msg.id, ...out } satisfies WorkerResponse),
    // evaluateHook classifies every hook-caused failure itself; reaching here is a runner
    // fault (the instance could not be created), which the pool answers as a 500.
    (err: unknown) =>
      port.postMessage({ id: msg.id, crashed: String(err) } satisfies WorkerResponse)
  );
});

port.postMessage({ ready: true } satisfies WorkerResponse);
