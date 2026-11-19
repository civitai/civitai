import { MAX_REMIX_EFFECTS, MAX_REMIX_RESULT_CHARS, REMIX_REPLAY_TIMEOUT_MS } from './limits.ts';
import { fault } from './result.ts';
import type { HookFaultCause, HookResult } from './result.ts';
import { classifyVmError, evaluateOn, instantiate, loadModule } from './sandbox.ts';
import type { CallScope, CompiledQuickJS } from './sandbox.ts';

/**
 * Remix app replay (`POST /v1/remix/replay`). A remix app is a module whose default export is
 * `defineRemixApp({ async run(ctx) { ... } })`; `run` asks the host for steps through
 * `ctx.workflow(request)` and `ctx.ask(spec)`. The host keeps a log of each step's result, and
 * replays the app from the start over that log every time the run moves on.
 *
 * In here runs only the replay loop: each call the app makes is recorded as an effect and answered
 * from the log, and the replay stops at the first call the log has no entry for. Nothing in the VM
 * is trusted: the app can change any intrinsic the loop uses, so the civitai host checks every
 * effect and output this returns (shape, limits, that each image is the source or from the run).
 *
 * Isolation is stronger than a hook call's: every replay gets a fresh runtime AND every call (one
 * request, up to 1 + MAX_REMIX_BRANCHES replays) a fresh WebAssembly instance, since an author can
 * see what their own unreviewed app returns. `Date` and `Math.random` are removed so an app is a
 * pure function of its input, which replay depends on.
 */

export type RemixLogEntry =
  | { type: 'workflow'; result: { workflowId: string; images: unknown[] } }
  | { type: 'ask'; answer: string | number };

export type RemixArgs = {
  source: string;
  /** The app's `ctx.source` (the image being remixed). */
  image: { imageId: number; url: string; width: number; height: number };
  /** Each log is replayed on its own fresh runtime, in order. */
  logs: RemixLogEntry[][];
  /** Answer each ask the log has no entry for with its first answer, until a workflow. */
  autoAnswer?: 'first';
};

export type RemixEffect =
  | { type: 'workflow'; request: unknown }
  | { type: 'ask'; spec: unknown; answer?: string | number };

export type RemixReplayResult =
  | { effects: RemixEffect[]; done?: { outputs: unknown[] } }
  | { cause: HookFaultCause; detail: string };

export type RemixOutput = { results: RemixReplayResult[]; elapsedMs: number };

/**
 * The prelude's last expression is the replay loop, captured before the app's module runs.
 * `defineRemixApp` is the identity: the app object is what the module exports.
 */
const PRELUDE = `
delete globalThis.Date;
delete Math.random;
globalThis.defineRemixApp = (app) => app;
(() => {
  const STOP = Object.freeze({});
  const firstAnswer = (spec) =>
    spec.kind === 'choice' ? spec.options[0].value : spec.kind === 'pick' ? 0 : 'remix';
  return (app, input) => {
    const log = input.log;
    const auto = input.autoAnswer === 'first';
    const effects = [];
    let next = 0;
    let stopped = false;
    const stop = (effect) => {
      if (effect) effects[effects.length] = effect;
      stopped = true;
      throw STOP;
    };
    const step = (effect) => {
      if (stopped) stop();
      // The one past the limit is returned too, so the host refuses it by its own limit.
      if (effects.length >= ${MAX_REMIX_EFFECTS}) stop(effect);
      const entry = log[next++];
      if (!entry) {
        if (!auto || effect.type !== 'ask') stop(effect);
        let answer;
        try {
          answer = firstAnswer(effect.spec);
        } catch {
          stop(effect);
        }
        effects[effects.length] = { type: 'ask', spec: effect.spec, answer };
        return answer;
      }
      if (entry.type !== effect.type) stop(effect);
      effects[effects.length] = effect;
      return entry.type === 'workflow' ? entry.result : entry.answer;
    };
    const ctx = Object.freeze({
      source: Object.freeze(input.source),
      workflow: async (request) => step({ type: 'workflow', request }),
      ask: async (spec) => step({ type: 'ask', spec }),
    });
    let settled = false;
    let failed = false;
    let value;
    (async () => app.run(ctx))().then(
      (v) => { settled = true; value = v; },
      (e) => { settled = true; failed = true; value = e; }
    );
    return () => {
      // A stop is final: an app that caught it and went on still stops there.
      if (stopped) return { effects };
      if (!settled) return { pending: true };
      if (failed) throw value;
      return { effects, done: { outputs: value } };
    };
  };
})()`;

/** Every replay of one call, on a WebAssembly instance of its own. */
export async function evaluateRemix(
  compiled: CompiledQuickJS,
  args: RemixArgs
): Promise<RemixOutput> {
  const t0 = performance.now();
  let qjs = await instantiate(compiled);
  const results: RemixReplayResult[] = [];
  for (const log of args.logs) {
    const input = JSON.stringify({ source: args.image, log, autoAnswer: args.autoAnswer });
    // A failed dispose throws SandboxDisposeError: a runner fault, which fails the whole call.
    const { result, poisoned } = evaluateOn(qjs, REMIX_REPLAY_TIMEOUT_MS, (scope) =>
      replay(scope, args.source, input)
    );
    results.push('allow' in result ? toFault(result) : result);
    if (poisoned) qjs = await instantiate(compiled);
  }
  return { results, elapsedMs: performance.now() - t0 };
}

function toFault(result: HookResult): RemixReplayResult {
  if (result.allow || result.cause === 'denied')
    return { cause: 'invalid_result', detail: 'unexpected hook result' };
  return { cause: result.cause, detail: result.detail };
}

function replay(
  scope: CallScope,
  source: string,
  inputJson: string
): RemixReplayResult | HookResult {
  const { rt, ctx, keep, wasInterrupted, pastDeadline } = scope;
  const loaded = loadModule(scope, source, PRELUDE);
  if ('allow' in loaded) return loaded;
  const { ns, engine, json, parse, stringify, preludeValue: driver } = loaded;
  const vmError = (err: ReturnType<typeof keep>) =>
    classifyVmError(ctx, err, wasInterrupted(), engine);

  const app = keep(ctx.getProp(ns, 'default'));
  const parsed = ctx.callFunction(parse, json, keep(ctx.newString(inputJson)));
  if (parsed.error) return vmError(keep(parsed.error));
  const started = ctx.callFunction(driver, ctx.undefined, app, keep(parsed.value));
  if (started.error) return vmError(keep(started.error));
  const finish = keep(started.value);

  // The app's awaits run as the interpreter's own promise jobs, under the same deadline.
  while (rt.hasPendingJob()) {
    if (pastDeadline()) return fault('timeout', 'interrupted at the deadline');
    const jobs = rt.executePendingJobs();
    if (jobs.error) return vmError(keep(jobs.error));
  }

  const finished = ctx.callFunction(finish, ctx.undefined);
  if (finished.error) return vmError(keep(finished.error));
  const serialised = ctx.callFunction(stringify, json, keep(finished.value));
  if (serialised.error) {
    const e = vmError(keep(serialised.error));
    return !e.allow && e.cause === 'error'
      ? fault('invalid_result', `result could not be serialised: ${e.detail}`)
      : e;
  }
  const text = keep(serialised.value);
  return validateRemixReturn(ctx.typeof(text) === 'string' ? ctx.getString(text) : undefined);
}

/** The loop's own result, checked for shape only: the civitai host checks every effect. */
export function validateRemixReturn(json: string | undefined): RemixReplayResult | HookResult {
  if (json === undefined) return fault('invalid_result', 'replay returned nothing');
  if (json.length > MAX_REMIX_RESULT_CHARS)
    return fault('invalid_result', `result exceeds ${MAX_REMIX_RESULT_CHARS} characters`);
  let v: { effects?: unknown; done?: unknown; pending?: unknown } | null;
  try {
    v = JSON.parse(json);
  } catch {
    return fault('invalid_result', 'result is not JSON');
  }
  if (typeof v !== 'object' || v === null)
    return fault('invalid_result', 'result is not an object');
  if (v.pending === true) return fault('invalid_result', 'run never settled');
  const effects = v.effects;
  if (
    !Array.isArray(effects) ||
    effects.length > MAX_REMIX_EFFECTS + 1 ||
    !effects.every(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        ((e as { type?: unknown }).type === 'workflow' || (e as { type?: unknown }).type === 'ask')
    )
  )
    return fault('invalid_result', 'effects are not a list of steps');
  if (v.done === undefined) return { effects: effects as RemixEffect[] };
  const outputs = (v.done as { outputs?: unknown } | null)?.outputs;
  if (!Array.isArray(outputs))
    return fault('invalid_result', 'run did not return a list of images');
  return { effects: effects as RemixEffect[], done: { outputs } };
}
