import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-ng-wasmfile-release-sync';
import { MAX_STACK_BYTES, MEMORY_LIMIT_BYTES } from './limits.ts';
import { fault, validateHookReturn } from './result.ts';
import type { HookResult } from './result.ts';

/**
 * One hook evaluation, with no state carried between calls.
 *
 * ISOLATION GRANULARITY: a fresh QuickJS RUNTIME (and context) per call, inside ONE WebAssembly
 * instance per worker that is shared by that worker's calls. Chosen for latency: in CI run
 * 41981302173 a fresh instance per call cost p50 3.05 / p99 35.7 ms against 0.71 / 4.96 ms for a
 * fresh runtime (1 KiB hook). Every JS-visible thing (globals, module state, prototypes, heap
 * objects) belongs to the runtime and is freed with it, so nothing a hook can observe carries
 * over. What IS shared is the instance's linear memory and its allocator: the accepted residual
 * risk is a QuickJS memory-safety bug reading freed memory of an earlier call.
 *
 * WHEN THE SHARED INSTANCE IS DISCARDED (`QuickJSInstance`): after any call that leaves the VM
 * by a route other than a clean in-VM exception, namely a throw out of the WASM boundary (a WASM
 * trap such as an emscripten abort, or a host stack overflow), a failure creating the runtime or
 * context, or a failure disposing them (for example an assertion on leaked objects). After those the
 * instance's allocator state is unknown, so the worker drops it and instantiates a new one from
 * the module compiled once at startup. A clean in-VM exception (a throw, out of memory, stack
 * overflow, the interrupt) unwinds through QuickJS's own error path and frees the runtime
 * normally, so it keeps the instance: tests pin that the next call on the same worker is
 * unaffected after each of them.
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

/** A new QuickJS WASM instance from the once-compiled module. */
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

export type SandboxOutput = EvaluateOutput & {
  /** The call left the instance in an unknown state; it must not be used again. */
  poisoned: boolean;
};

/**
 * A worker's shared QuickJS instance. `evaluate` runs one call on a fresh runtime inside it and
 * replaces the instance after any call that may have left it unsafe (see the header).
 */
export class QuickJSInstance {
  private current: Promise<QuickJSWASMModule> | null = null;
  private readonly create: () => Promise<QuickJSWASMModule>;
  /** How many instances were created; 1 after the first call. */
  created = 0;

  constructor(create: () => Promise<QuickJSWASMModule>) {
    this.create = create;
  }

  static fromCompiled(compiled: CompiledQuickJS): QuickJSInstance {
    return new QuickJSInstance(() => instantiate(compiled));
  }

  async evaluate(args: EvaluateArgs): Promise<SandboxOutput> {
    if (!this.current) {
      this.created++;
      this.current = this.create();
    }
    const qjs = await this.current;
    let out: SandboxOutput;
    try {
      out = evaluateHookOn(qjs, args);
    } catch (err) {
      // Creating the runtime or context failed: a runner fault, never the hook's.
      this.current = null;
      throw err;
    }
    if (out.poisoned) this.current = null;
    return out;
  }
}

/** One call on a fresh runtime and context inside `qjs`. */
export function evaluateHookOn(qjs: QuickJSWASMModule, args: EvaluateArgs): SandboxOutput {
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
  let poisoned = false;
  try {
    result = run(ctx, keep, args, arm, () => interrupted);
  } catch (err) {
    // A throw out of the WASM boundary itself (a host stack overflow, a WASM trap). The instance's
    // state is unknown from here: the caller replaces it.
    poisoned = true;
    result = classifyHostError(err, interrupted);
  } finally {
    // A disposal failure (for example an assertion on leaked objects) also leaves the instance
    // in an unknown state.
    for (const h of handles.reverse()) {
      try {
        if (h.alive) h.dispose();
      } catch {
        poisoned = true;
      }
    }
    try {
      ctx.dispose();
      rt.dispose();
    } catch {
      poisoned = true;
    }
  }
  return { result, elapsedMs: performance.now() - start, poisoned };
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
