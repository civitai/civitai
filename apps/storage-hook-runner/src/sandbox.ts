import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-ng-wasmfile-release-sync';
import { MAX_STACK_BYTES, MEMORY_LIMIT_BYTES } from './limits.ts';
import { fault, validateHookReturn } from './result.ts';
import type { HookResult } from './result.ts';

/**
 * One hook evaluation, fully isolated.
 *
 * ISOLATION GRANULARITY: a fresh WebAssembly INSTANCE per call (its own linear memory), not just a
 * fresh QuickJS runtime inside a shared instance. Runtimes in one instance share one linear
 * memory, so a QuickJS memory-safety bug could read residue from an earlier call (another app's
 * documents). Measured on Node 24.21 (500 calls, one small hook): runtime-per-call p50 0.14 ms,
 * instance-per-call recompiling the WASM p50 1.5-2.1 ms, instance-per-call from a WASM module
 * compiled ONCE p50 0.68 ms. The last is what this file does: `compileQuickJS()` compiles the
 * immutable code once per worker; every call instantiates it fresh. The CI benchmark
 * (src/__tests__/benchmark.test.ts) re-measures both modes.
 *
 * NO CAPABILITIES: the context gets QuickJS's standard intrinsics, minus the two non-ES globals
 * quickjs-ng adds (`performance`, `queueMicrotask`), and nothing else. No host
 * function is ever registered, no module loader is set (so `import` fails with a ReferenceError),
 * and there is no `console`, `fetch`, timer, `require` or `process`. Input crosses as a JSON
 * string parsed INSIDE the VM; the result crosses back as a JSON string serialised INSIDE the VM,
 * then validated here. So no host object is ever reachable from hook code.
 *
 * NO BYTECODE CACHE: quickjs-emscripten 0.32.0 has no public API to serialise compiled bytecode
 * (`compileOnly` returns a handle bound to the runtime that made it), and a cached runtime would
 * break per-call isolation. The source is compiled on every call; the benchmark measures that at
 * 1 KiB and 64 KiB.
 */

export type CompiledQuickJS = { variant: typeof variant };

// Neither lib ES2022 nor @types/node declares the WebAssembly global; Node has it.
declare const WebAssembly: { Module: new (bytes: Uint8Array) => object };

/** True unless `ctx.getPromiseState` says the handle is not a promise at all. */
function isPromiseState(st: ReturnType<QuickJSContext['getPromiseState']>): boolean {
  return !(st.type === 'fulfilled' && st.notAPromise === true);
}

/** Compile the QuickJS WASM once (per worker). Pure CPU, no network. */
export function compileQuickJS(): CompiledQuickJS {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('@jitl/quickjs-ng-wasmfile-release-sync/wasm');
  const wasmModule = new WebAssembly.Module(readFileSync(wasmPath));
  return { variant: newVariant(variant, { wasmModule }) };
}

/** A fresh, never-shared QuickJS WASM instance. */
export function instantiate(compiled: CompiledQuickJS): Promise<QuickJSWASMModule> {
  return newQuickJSWASMModuleFromVariant(compiled.variant);
}

export type EvaluateArgs = {
  source: string;
  /** The hook's argument, as JSON text. */
  inputJson: string;
  timeoutMs: number;
};

export type EvaluateOutput = {
  result: HookResult;
  /** Wall time from arming the deadline (just before the hook's module runs) to the answer. */
  elapsedMs: number;
};

/** Evaluate on a fresh instance. This is what the runner does for every request. */
export async function evaluateHook(
  compiled: CompiledQuickJS,
  args: EvaluateArgs
): Promise<EvaluateOutput> {
  return evaluateHookOn(await instantiate(compiled), args);
}

/**
 * Evaluate on a GIVEN instance, with a fresh runtime and context. The runner never reuses an
 * instance; this is exported so the benchmark can measure runtime-per-call against it.
 */
export function evaluateHookOn(qjs: QuickJSWASMModule, args: EvaluateArgs): EvaluateOutput {
  const rt = qjs.newRuntime();
  rt.setMemoryLimit(MEMORY_LIMIT_BYTES);
  rt.setMaxStackSize(MAX_STACK_BYTES);

  // `interrupted` is the authority for `timeout`: it is set only when THIS handler stopped the
  // VM, so hook code cannot fake a timeout (or hide one) by throwing an error that looks like it.
  // QuickJS's interrupt exception is uncatchable, and once the deadline passes the handler keeps
  // answering true, so a `catch` or `finally` cannot keep running either.
  //
  // The deadline is ARMED by `run` immediately before the hook's module is evaluated, not here:
  // the sandbox's own setup (the prelude) must neither spend the hook's budget nor be the place
  // an interrupt lands, which once surfaced as a setup `error` instead of a `timeout` at 1 ms.
  let interrupted = false;
  let start = performance.now();
  let deadline = Number.POSITIVE_INFINITY;
  const arm = () => {
    start = performance.now();
    deadline = start + args.timeoutMs;
  };
  rt.setInterruptHandler(() => {
    if (performance.now() >= deadline) {
      interrupted = true;
      return true;
    }
    return false;
  });

  const ctx = rt.newContext();
  const handles: QuickJSHandle[] = [];
  const keep = (h: QuickJSHandle) => {
    handles.push(h);
    return h;
  };

  let result: HookResult;
  try {
    result = run(ctx, keep, args, arm, () => interrupted);
  } catch (err) {
    // A throw out of the VM boundary itself (host stack overflow, a WASM trap). The instance is
    // never reused, so nothing carries over.
    result = classifyHostError(err, interrupted);
  } finally {
    // Disposal can assert after an OOM or trap; the instance is dropped either way.
    for (const h of handles.reverse()) {
      try {
        if (h.alive) h.dispose();
      } catch {
        /* dropped with the instance */
      }
    }
    try {
      ctx.dispose();
      rt.dispose();
    } catch {
      /* dropped with the instance */
    }
  }
  return { result, elapsedMs: performance.now() - start };
}

function run(
  ctx: QuickJSContext,
  keep: (h: QuickJSHandle) => QuickJSHandle,
  args: EvaluateArgs,
  arm: () => void,
  wasInterrupted: () => boolean
): HookResult {
  // quickjs-ng's base objects include two non-ES globals: `performance` (a high-resolution
  // clock, a timing side channel) and `queueMicrotask` (a scheduler). Neither is needed by a
  // pure check, so both are removed before the hook runs. `Date` stays: it is ECMAScript.
  const strip = ctx.evalCode(
    'delete globalThis.performance; delete globalThis.queueMicrotask;',
    'prelude.js',
    { type: 'global', strict: false }
  );
  if (strip.error) return classifyVmError(ctx, keep(strip.error), wasInterrupted());
  keep(strip.value);

  // Taken BEFORE the hook's module runs, so a module that reassigns `JSON.parse` or
  // `JSON.stringify` cannot change how its own input is decoded or its result encoded.
  const json = keep(ctx.getProp(ctx.global, 'JSON'));
  const parse = keep(ctx.getProp(json, 'parse'));
  const stringify = keep(ctx.getProp(json, 'stringify'));

  arm();
  const evaluated = ctx.evalCode(args.source, 'hook.js', { type: 'module', strict: true });
  if (evaluated.error) {
    return classifyVmError(ctx, keep(evaluated.error), wasInterrupted());
  }
  const ns = keep(evaluated.value);

  // A module without top-level await evaluates to its namespace. One WITH top-level await
  // evaluates to a promise, which would need the job queue run: v1 hooks are synchronous.
  const nsState = ctx.getPromiseState(ns);
  if (isPromiseState(nsState)) {
    if (nsState.type === 'fulfilled') keep(nsState.value);
    if (nsState.type === 'rejected') keep(nsState.error);
    return fault('error', 'top-level await is not supported (v1 hooks are synchronous)');
  }

  const fn = keep(ctx.getProp(ns, 'default'));
  if (ctx.typeof(fn) !== 'function') {
    return fault('error', 'the module has no default export function');
  }

  const inputText = keep(ctx.newString(args.inputJson));
  const parsed = ctx.callFunction(parse, json, inputText);
  if (parsed.error) return classifyVmError(ctx, keep(parsed.error), wasInterrupted());
  const input = keep(parsed.value);

  const called = ctx.callFunction(fn, ctx.undefined, input);
  if (called.error) return classifyVmError(ctx, keep(called.error), wasInterrupted());
  const out = keep(called.value);

  const outState = ctx.getPromiseState(out);
  if (isPromiseState(outState)) {
    if (outState.type === 'fulfilled') keep(outState.value);
    if (outState.type === 'rejected') keep(outState.error);
    return fault('invalid_result', 'hook returned a Promise (v1 hooks are synchronous)');
  }

  // Serialised inside the VM, so getters and toJSON run under the same limits as the hook.
  const serialised = ctx.callFunction(stringify, json, out);
  if (serialised.error) {
    const e = classifyVmError(ctx, keep(serialised.error), wasInterrupted());
    if (!e.allow && e.cause === 'error') {
      return fault('invalid_result', `hook result could not be serialised: ${e.detail}`);
    }
    return e;
  }
  const text = keep(serialised.value);
  return validateHookReturn(ctx.typeof(text) === 'string' ? ctx.getString(text) : undefined);
}

function classifyVmError(
  ctx: QuickJSContext,
  err: QuickJSHandle,
  interrupted: boolean
): HookResult {
  if (interrupted) return fault('timeout', 'interrupted at the deadline');
  const { name, message } = describe(ctx, err);
  if (name === 'InternalError' && message === 'out of memory') {
    return fault('oom', 'out of memory');
  }
  if (name === 'RangeError' && /call stack/i.test(message)) {
    return fault('stack_overflow', message);
  }
  return fault('error', name ? `${name}: ${message}` : message);
}

function classifyHostError(err: unknown, interrupted: boolean): HookResult {
  if (interrupted) return fault('timeout', 'interrupted at the deadline');
  if (err instanceof RangeError && /call stack/i.test(err.message)) {
    return fault('stack_overflow', 'host stack exhausted');
  }
  return fault('error', `sandbox trap: ${err instanceof Error ? err.name : 'unknown'}`);
}

function describe(ctx: QuickJSContext, err: QuickJSHandle): { name: string; message: string } {
  try {
    const d = ctx.dump(err) as unknown;
    if (d && typeof d === 'object') {
      const o = d as { name?: unknown; message?: unknown };
      return {
        name: typeof o.name === 'string' ? o.name : '',
        message: typeof o.message === 'string' ? o.message : String(o.message ?? ''),
      };
    }
    return { name: '', message: `thrown value: ${String(d)}` };
  } catch {
    return { name: '', message: 'thrown value could not be read' };
  }
}
