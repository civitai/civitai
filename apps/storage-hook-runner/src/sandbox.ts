import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-ng-wasmfile-release-sync';
import {
  COMPILE_ALLOWANCE_FACTOR,
  COMPILE_ALLOWANCE_FLOOR_MS,
  MAX_STACK_BYTES,
  MEMORY_LIMIT_BYTES,
} from './limits.ts';
import { fault, validateHookReturn } from './result.ts';
import type { HookResult } from './result.ts';

/**
 * One hook evaluation, with no state carried between calls.
 *
 * ISOLATION GRANULARITY: a fresh QuickJS RUNTIME (and context) per call, inside ONE WebAssembly
 * instance per worker that is shared by that worker's calls. Chosen for latency: a fresh instance
 * per call costs several times a fresh runtime (the benchmark measures both). Every JS-visible
 * thing (globals, module state, prototypes, heap objects) belongs to the runtime and is freed
 * with it, so nothing a hook can observe carries over. What IS shared is the instance's linear
 * memory and its allocator: the accepted residual risk is a QuickJS memory-safety bug reading
 * freed memory of an earlier call.
 *
 * WHEN THE SHARED INSTANCE IS DISCARDED (`QuickJSInstance`): after any call that leaves the VM
 * by a route other than a clean in-VM exception, namely a throw out of the WASM boundary (a WASM
 * trap such as an emscripten abort, or a host stack overflow), a failure creating the runtime or
 * context, a failure disposing them (for example an assertion on leaked objects), or a failed
 * instantiation. After those the instance's allocator state is unknown, so the worker drops it
 * and instantiates a new one from the module compiled once at startup. A clean in-VM exception
 * (a throw, out of memory, stack overflow, the interrupt) unwinds through QuickJS's own error
 * path and frees the runtime normally, so it keeps the instance: tests pin that the next call
 * on the same worker is unaffected after each of them.
 *
 * WHO IS AT FAULT: a WASM-boundary throw during the hook's own run still answers with a refusal
 * (stack_overflow or error) attributed to the author, since the hook's code drove it there. Every
 * other unsafe ending above is a RUNNER fault: the call rejects (the worker answers 500) and no
 * answer computed by it is ever returned.
 *
 * NO CAPABILITIES: the context gets QuickJS's standard intrinsics, minus three non-ES globals
 * quickjs-ng adds (`performance`, `queueMicrotask`, `InternalError`), and nothing else. No host
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
 * Disposing the call's handles, context or runtime failed. A RUNNER fault: the call's computed
 * answer is discarded (never returned, so a failed dispose can never leak an allow), the
 * instance is replaced, and the worker answers 500, which the caller maps to hook_unavailable.
 */
export class SandboxDisposeError extends Error {}

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
    let out: SandboxOutput;
    try {
      // Inside the try: a rejected instantiation must be dropped too, or every later call would
      // await the same rejected promise and the worker would answer 500 forever.
      const qjs = await this.current;
      out = evaluateHookOn(qjs, args);
    } catch (err) {
      // Instantiation failed, the runtime or context could not be created, or disposal failed
      // (SandboxDisposeError): a runner fault, never the hook's. Start the next call on a new
      // instance.
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

  // `interrupted`, set only when THIS handler stopped the VM, decides `timeout`, never an error's
  // name: hook code cannot fake a timeout (or hide one) by throwing a look-alike.
  //
  // `run` arms the deadline after a compile-only pass. quickjs-emscripten cannot run an already
  // compiled module, so the evaluation compiles again, and the budget is extended to cover that
  // second compile: see COMPILE_ALLOWANCE_* in limits.ts.
  let interrupted = false;
  let start = performance.now();
  let deadline = Number.POSITIVE_INFINITY;
  const arm = (compileMs: number) => {
    start = performance.now();
    deadline =
      start + COMPILE_ALLOWANCE_FACTOR * compileMs + COMPILE_ALLOWANCE_FLOOR_MS + args.timeoutMs;
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
  let disposeFailed = false;
  try {
    result = run(ctx, keep, args, arm, () => interrupted);
    // An interrupt can be SWALLOWED: one that fires inside `Error.prepareStackTrace` while QuickJS
    // builds a stack (`new Error()`, `Error.captureStackTrace`, reading `.stack`) is discarded
    // and the hook carries on. Whatever it then returned, past its deadline, is a timeout.
    if (interrupted) result = fault('timeout', 'interrupted at the deadline');
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
        disposeFailed = true;
      }
    }
    try {
      ctx.dispose();
      rt.dispose();
    } catch {
      disposeFailed = true;
    }
  }
  if (disposeFailed) throw new SandboxDisposeError('disposing the call failed');
  return { result, elapsedMs: performance.now() - start, poisoned };
}

function run(
  ctx: QuickJSContext,
  keep: (h: QuickJSHandle) => QuickJSHandle,
  args: EvaluateArgs,
  arm: (compileMs: number) => void,
  wasInterrupted: () => boolean
): HookResult {
  // The engine's own out-of-memory error is an InternalError. Its prototype and
  // Object.getPrototypeOf are captured BEFORE any hook code runs, and the InternalError global
  // is then removed, so hook code cannot construct one: `oom` is decided by the error's identity,
  // not by a name and message a hook could copy (see classifyVmError).
  // The check is a closure created here, over the intrinsics as they are before the hook runs
  // (this WASM build has no host-side identity comparison: `ctx.eq` throws "does not expose
  // equality").
  const checker = ctx.evalCode(
    '(() => { const P = InternalError.prototype; const g = Object.getPrototypeOf; return (e) => e !== null && typeof e === "object" && g(e) === P; })()',
    'engine.js',
    { type: 'global', strict: true }
  );
  if (checker.error) {
    keep(checker.error);
    throw new Error('sandbox setup failed');
  }
  const engine: EngineIntrinsics = { isInternalError: keep(checker.value) };

  // quickjs-ng's base objects include non-ES globals: `performance` (a high-resolution clock, a
  // timing side channel), `queueMicrotask` (a scheduler) and `InternalError` (above). None is
  // needed by a pure check, so all three are removed before the hook runs. `Date` stays: it is
  // ECMAScript.
  const strip = ctx.evalCode(
    'delete globalThis.performance; delete globalThis.queueMicrotask; delete globalThis.InternalError;',
    'prelude.js',
    { type: 'global', strict: false }
  );
  if (strip.error) return classifyVmError(ctx, keep(strip.error), wasInterrupted(), engine);
  keep(strip.value);

  // Taken BEFORE the hook's module runs, so a module that reassigns `JSON.parse` or
  // `JSON.stringify` cannot change how its own input is decoded or its result encoded.
  const json = keep(ctx.getProp(ctx.global, 'JSON'));
  const parse = keep(ctx.getProp(json, 'parse'));
  const stringify = keep(ctx.getProp(json, 'stringify'));

  // Compile-only pass, deadline disarmed: a syntax error is reported from here, and its
  // duration sizes the compile allowance (COMPILE_ALLOWANCE_* in limits.ts).
  const compileStart = performance.now();
  const compiled = ctx.evalCode(args.source, 'hook.js', {
    type: 'module',
    strict: true,
    compileOnly: true,
  });
  if (compiled.error) return classifyVmError(ctx, keep(compiled.error), wasInterrupted(), engine);
  keep(compiled.value);
  arm(performance.now() - compileStart);

  const evaluated = ctx.evalCode(args.source, 'hook.js', { type: 'module', strict: true });
  if (evaluated.error) {
    return classifyVmError(ctx, keep(evaluated.error), wasInterrupted(), engine);
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
  if (parsed.error) return classifyVmError(ctx, keep(parsed.error), wasInterrupted(), engine);
  const input = keep(parsed.value);

  const called = ctx.callFunction(fn, ctx.undefined, input);
  if (called.error) return classifyVmError(ctx, keep(called.error), wasInterrupted(), engine);
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
    const e = classifyVmError(ctx, keep(serialised.error), wasInterrupted(), engine);
    if (!e.allow && e.cause === 'error') {
      return fault('invalid_result', `hook result could not be serialised: ${e.detail}`);
    }
    return e;
  }
  const text = keep(serialised.value);
  return validateHookReturn(ctx.typeof(text) === 'string' ? ctx.getString(text) : undefined);
}

type EngineIntrinsics = {
  /** In-VM `(e) => Object.getPrototypeOf(e) === InternalError.prototype`, captured pre-hook. */
  isInternalError: QuickJSHandle;
};

/** True only for an error whose prototype IS the engine's InternalError.prototype. */
function isEngineInternalError(
  ctx: QuickJSContext,
  err: QuickJSHandle,
  engine: EngineIntrinsics
): boolean {
  const r = ctx.callFunction(engine.isInternalError, ctx.undefined, err);
  if (r.error) {
    r.error.dispose();
    return false;
  }
  const yes = ctx.typeof(r.value) === 'boolean' && ctx.dump(r.value) === true;
  r.value.dispose();
  return yes;
}

/**
 * - timeout: decided by the interrupt flag alone.
 * - oom: the engine's own InternalError (by prototype identity, which hook code cannot obtain
 *   without a real out-of-memory) with QuickJS's message.
 * - stack_overflow: a RangeError with QuickJS's call-stack message. RangeError is a standard
 *   constructor, so hook code CAN throw a look-alike; that only relabels one author fault as
 *   another (both are refusals, both refunded), so it is accepted rather than worked around.
 */
function classifyVmError(
  ctx: QuickJSContext,
  err: QuickJSHandle,
  interrupted: boolean,
  engine: EngineIntrinsics
): HookResult {
  if (interrupted) return fault('timeout', 'interrupted at the deadline');
  const { name, message } = describe(ctx, err);
  if (message === 'out of memory' && isEngineInternalError(ctx, err, engine)) {
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
