import {
  MAX_REMIX_ANSWER_CHARS,
  MAX_REMIX_EFFECTS,
  MAX_REMIX_RESULT_CHARS,
  MAX_REMIX_RESULT_DEPTH,
  REMIX_REPLAY_TIMEOUT_MS,
} from './limits.ts';
import { fault } from './result.ts';
import type { HookFaultCause, HookResult } from './result.ts';
import { classifyVmError, evaluateOn, instantiate, loadModule } from './sandbox.ts';
import type { CallScope, CompiledQuickJS } from './sandbox.ts';
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';

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
  const TOO_BIG = Object.freeze({});
  // Taken before the app's module runs, so it cannot change how its result is written out.
  const keysOf = Object.keys;
  const isArray = Array.isArray;
  const isFinite = Number.isFinite;
  const quote = JSON.stringify;
  const defineProperty = Object.defineProperty;
  const freeze = Object.freeze;
  const apply = Reflect.apply;
  const then = Promise.prototype.then;
  // An own property, so no accessor the app put on Array.prototype sees the write.
  const put = (list, value) =>
    defineProperty(list, list.length, {
      __proto__: null,
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  // JSON, written in JS so it polls the interrupt, bounded in depth and size, and never asks the
  // app's objects (toJSON, a prototype) how to write them.
  const write = (v, depth, out) => {
    if (depth > ${MAX_REMIX_RESULT_DEPTH} || out.n > ${MAX_REMIX_RESULT_CHARS}) throw TOO_BIG;
    let s;
    if (v === null || v === undefined) s = 'null';
    else if (typeof v === 'string') {
      // Before the native copy, which does not poll the interrupt.
      if (v.length > ${MAX_REMIX_RESULT_CHARS} - out.n) throw TOO_BIG;
      s = quote(v);
    }
    else if (typeof v === 'number') s = isFinite(v) ? '' + v : 'null';
    else if (typeof v === 'boolean') s = v ? 'true' : 'false';
    else if (typeof v !== 'object') s = 'null';
    else if (isArray(v)) {
      out.push('[');
      for (let i = 0; i < v.length; i++) {
        if (i) out.push(',');
        write(v[i], depth + 1, out);
      }
      out.push(']');
      return;
    } else {
      out.push('{');
      const ks = keysOf(v);
      for (let i = 0; i < ks.length; i++) {
        if (i) out.push(',');
        if (ks[i].length > ${MAX_REMIX_RESULT_CHARS} - out.n) throw TOO_BIG;
        out.push(quote(ks[i]) + ':');
        write(v[ks[i]], depth + 1, out);
      }
      out.push('}');
      return;
    }
    out.push(s);
  };
  const toJson = (v) => {
    let text = '';
    const out = { n: 0, push: (s) => { text += s; out.n = text.length; } };
    try {
      write(v, 0, out);
    } catch (e) {
      if (e === TOO_BIG) return '{"tooBig":true}';
      throw e;
    }
    return text;
  };
  // A choice's option value is the app's: it crosses as an answer only if the log can carry it back.
  const isAnswer = (v) =>
    typeof v === 'string'
      ? v.length <= ${MAX_REMIX_ANSWER_CHARS}
      : typeof v === 'number' && v >= 0 && v <= 9007199254740991 && v % 1 === 0;
  const firstAnswer = (spec) =>
    spec.kind === 'choice' ? spec.options[0].value : spec.kind === 'pick' ? 0 : 'remix';
  return (app, input) => {
    const log = input.log;
    const auto = input.autoAnswer === 'first';
    const effects = [];
    let next = 0;
    let stopped = false;
    let answering = false;
    let badAnswer = false;
    const stop = (effect) => {
      stopped = true;
      if (effect) put(effects, effect);
      throw STOP;
    };
    const step = (effect) => {
      if (stopped) stop();
      // A step taken by a getter while an answer is read is no step of the run.
      if (answering) {
        stopped = true;
        throw STOP;
      }
      // The one past the limit is returned too, so the host refuses it by its own limit.
      if (effects.length >= ${MAX_REMIX_EFFECTS}) stop(effect);
      // Past the log's own entries, never a hole an Array.prototype getter could fill.
      const entry = next < log.length ? log[next] : undefined;
      next++;
      if (!entry) {
        if (!auto || effect.type !== 'ask') stop(effect);
        let answer;
        answering = true;
        try {
          answer = firstAnswer(effect.spec);
        } catch {
          stop(effect);
        } finally {
          answering = false;
        }
        // A getter inside firstAnswer took a step: this ask is where the run stops, unanswered.
        if (stopped) stop(effect);
        if (!isAnswer(answer)) {
          badAnswer = true;
          stop(effect);
        }
        put(effects, { type: 'ask', spec: effect.spec, answer });
        return answer;
      }
      if (entry.type !== effect.type) stop(effect);
      put(effects, effect);
      return entry.type === 'workflow' ? entry.result : entry.answer;
    };
    const ctx = freeze({
      source: freeze(input.source),
      workflow: async (request) => step({ type: 'workflow', request }),
      ask: async (spec) => step({ type: 'ask', spec }),
    });
    let settled = false;
    let failed = false;
    let value;
    // Not through an async wrapper: resolving one with run's promise would look up then on it,
    // which the app can replace. The captured then only takes a real promise.
    const ok = (v) => { settled = true; value = v; };
    const bad = (e) => { settled = true; failed = true; value = e; };
    let result;
    try {
      result = app.run(ctx);
    } catch (e) {
      bad(e);
    }
    if (!settled) {
      try {
        apply(then, result, [ok, bad]);
      } catch {
        ok(result);
      }
    }
    return () => {
      // A stop is final: an app that caught it and went on still stops there.
      if (stopped) return badAnswer ? '{"badAnswer":true}' : toJson({ effects });
      if (!settled) return '{"pending":true}';
      if (failed) throw value;
      if (next < log.length) return '{"short":true}';
      // A getter run while the result is written must not record a step the log check missed.
      stopped = true;
      return toJson({ effects, done: { outputs: value } });
    };
  };
})()`;

/** Every replay of one call, on a WebAssembly instance of its own. */
export async function evaluateRemix(
  compiled: CompiledQuickJS,
  args: RemixArgs,
  /** Test seam: how the call's instances are created. */
  create: () => Promise<QuickJSWASMModule> = () => instantiate(compiled)
): Promise<RemixOutput> {
  const t0 = performance.now();
  let qjs = await create();
  const results: RemixReplayResult[] = [];
  for (const log of args.logs) {
    // Always an own property: an absent one would be read through a prototype the app can change.
    const input = JSON.stringify({ source: args.image, log, autoAnswer: args.autoAnswer ?? null });
    // A failed dispose throws SandboxDisposeError: a runner fault, which fails the whole call.
    const { result, poisoned } = evaluateOn(qjs, REMIX_REPLAY_TIMEOUT_MS, (scope) =>
      replay(scope, args.source, input)
    );
    results.push('allow' in result ? toFault(result) : result);
    if (poisoned) qjs = await create();
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
  const { ns, engine, json, parse, preludeValue: driver } = loaded;
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

  // `finish` writes the result as JSON itself (see `toJson` in the prelude).
  const finished = ctx.callFunction(finish, ctx.undefined);
  if (finished.error) return vmError(keep(finished.error));
  const text = keep(finished.value);
  return validateRemixReturn(ctx.typeof(text) === 'string' ? ctx.getString(text) : undefined);
}

/** The loop's own result, checked for shape only: the civitai host checks every effect. */
export function validateRemixReturn(json: string | undefined): RemixReplayResult | HookResult {
  if (json === undefined) return fault('invalid_result', 'replay returned nothing');
  if (json.length > MAX_REMIX_RESULT_CHARS)
    return fault('invalid_result', `result exceeds ${MAX_REMIX_RESULT_CHARS} characters`);
  let v: {
    effects?: unknown;
    done?: unknown;
    pending?: unknown;
    short?: unknown;
    tooBig?: unknown;
    badAnswer?: unknown;
  } | null;
  try {
    v = JSON.parse(json);
  } catch {
    return fault('invalid_result', 'result is not JSON');
  }
  if (typeof v !== 'object' || v === null)
    return fault('invalid_result', 'result is not an object');
  if (v.pending === true) return fault('invalid_result', 'run never settled');
  if (v.short === true) return fault('invalid_result', 'run finished before the log ended');
  if (v.tooBig === true)
    return fault(
      'invalid_result',
      `result is nested past ${MAX_REMIX_RESULT_DEPTH} or longer than ${MAX_REMIX_RESULT_CHARS}`
    );
  if (v.badAnswer === true)
    return fault(
      'invalid_result',
      `an auto-answered option's value is not a string of at most ${MAX_REMIX_ANSWER_CHARS} characters or a non-negative safe integer`
    );
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
