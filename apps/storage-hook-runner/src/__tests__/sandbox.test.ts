import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import { BACKSTOP_MS } from '../limits.ts';
import { BackstopError, HookPool, PoolOverloadedError, WorkerCrashedError } from '../pool.ts';
import { compileQuickJS, evaluateHookOn, instantiate } from '../sandbox.ts';
import { hookInputJson, waitFor } from '../test-support/fixtures.ts';

/**
 * The sandbox, exercised the way the runner uses it: through the real worker pool, so every
 * case runs in a real worker_thread, on a fresh QuickJS runtime inside that worker's shared WASM
 * instance.
 */

let pool: HookPool;
beforeAll(async () => {
  pool = await HookPool.start({ size: 2 });
});
afterAll(async () => {
  await pool.close();
});

const run = (source: string, opts: { timeoutMs?: number; input?: string } = {}) =>
  pool.run({
    appId: 'app-test',
    source,
    inputJson: opts.input ?? hookInputJson(),
    timeoutMs: opts.timeoutMs ?? 50,
  });

describe('allow and deny', () => {
  it('returns {allow:true} from a hook that allows', async () => {
    const { result } = await run('export default function check() { return { allow: true }; }');
    expect(result).toEqual({ allow: true });
  });

  it('returns the reason from a hook that denies, decided from its input', async () => {
    const { result } = await run(
      'export default function check(i) { return i.before.title === "old title" && i.viewer.userId === 4242 ? { allow: false, reason: i.op + ": card is locked" } : { allow: true }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'denied', reason: 'put: card is locked' });
  });

  it('passes the input fields through unchanged', async () => {
    const input = hookInputJson({
      op: 'increment',
      after: null,
      tally: { kind: 'counter', name: 'likes', by: 5 },
      from: 'importer-app',
    });
    const { result } = await run(
      'export default function check(i) { return { allow: false, reason: JSON.stringify([i.op, i.key, i.after, i.tally, i.doc.counters, i.viewer.userId, i.app.blockId, i.from]) }; }',
      { input }
    );
    expect(result).toEqual({
      allow: false,
      cause: 'denied',
      reason:
        '["increment","key-7f3a",null,{"kind":"counter","name":"likes","by":5},{"likes":3},4242,"app-storage-demo","importer-app"]',
    });
  });
});

describe('time limit', () => {
  // The bound is asserted at two timeouts so a fixed sleep or a hardcoded deadline cannot pass
  // both. `elapsedMs` is measured inside the worker from arming the deadline. The detail is the
  // INTERRUPT HANDLER's, and no worker may be terminated: without the handler the backstop would
  // end the call instead (now as a BackstopError rejection, which also fails this test).
  it.each([10, 200])('interrupts an infinite loop at its %i ms deadline', async (ms) => {
    const terminatedBefore = pool.stats().terminated;
    const t0 = performance.now();
    const out = await run('export default function check() { for (;;) {} }', { timeoutMs: ms });
    const wall = performance.now() - t0;

    expect(out.result).toEqual({
      allow: false,
      cause: 'timeout',
      detail: 'interrupted at the deadline',
    });
    expect(out.elapsedMs).toBeGreaterThanOrEqual(ms);
    // Only "not far too late": well under the backstop, so CI load cannot turn it red.
    expect(out.elapsedMs).toBeLessThan(ms + BACKSTOP_MS / 2);
    expect(wall).toBeLessThan(ms + BACKSTOP_MS);
    expect(pool.stats().terminated).toBe(terminatedBefore);
  });

  // The deadline is not armed before the sandbox's own setup (the prelude that removes non-ES
  // globals): an interrupt landing there was reported as a setup error instead of a timeout. Many
  // calls at the smallest budget make that window likely to be hit.
  it('a 1 ms budget is always a timeout from the interrupt, never another cause', async () => {
    const causes = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const { result } = await run('export default function check() { for (;;) {} }', {
        timeoutMs: 1,
      });
      const key = JSON.stringify(result);
      causes.set(key, (causes.get(key) ?? 0) + 1);
    }
    expect(Object.fromEntries(causes)).toEqual({
      [JSON.stringify({
        allow: false,
        cause: 'timeout',
        detail: 'interrupted at the deadline',
      })]: 300,
    });
  });

  it('interrupts a loop at module top level', async () => {
    const { result } = await run(
      'for (;;) {}\nexport default function check() { return { allow: true }; }',
      {
        timeoutMs: 10,
      }
    );
    expect(result).toEqual({
      allow: false,
      cause: 'timeout',
      detail: 'interrupted at the deadline',
    });
  });

  it('cannot be caught, nor overridden by a finally block', async () => {
    const { result } = await run(
      'export default function check() { try { for (;;) {} } catch (e) { return { allow: true }; } finally { return { allow: true }; } }',
      { timeoutMs: 10 }
    );
    expect(result).toEqual({
      allow: false,
      cause: 'timeout',
      detail: 'interrupted at the deadline',
    });
  });

  it('a catastrophic regex is interrupted too', async () => {
    const { result } = await run(
      'export default function check() { /(a+)+$/.test("a".repeat(40) + "b"); return { allow: true }; }',
      { timeoutMs: 10 }
    );
    expect(result).toEqual({
      allow: false,
      cause: 'timeout',
      detail: 'interrupted at the deadline',
    });
  });
});

describe('worker backstop', () => {
  // A backstop termination is a RUNNER fault (the in-VM interrupt failed to stop the call), so
  // the pool rejects with BackstopError (answered 500) instead of blaming the author with
  // `timeout`.
  it('terminates a worker stuck in native code that never polls the interrupt, as a runner fault, and recovers', async () => {
    // This loop runs in allocation/GC near the memory cap far longer than any backstop on a
    // single interrupt poll. A pool with a 20 ms backstop must cut it at ~30 ms.
    const backstopped: string[] = [];
    const p = await HookPool.start({
      size: 1,
      backstopMs: 20,
      onBackstop: (app) => backstopped.push(app),
    });
    try {
      const t0 = performance.now();
      const out = p.run({
        appId: 'app-stall',
        source:
          'export default function check() { const a = []; for (;;) a.push(new Array(1e5).fill(1)); }',
        inputJson: hookInputJson(),
        timeoutMs: 10,
      });
      await expect(out).rejects.toBeInstanceOf(BackstopError);
      const wall = performance.now() - t0;
      expect(wall).toBeLessThan(5 * BACKSTOP_MS);
      expect(p.stats().terminated).toBe(1);
      expect(backstopped).toEqual(['app-stall']);

      // The replacement worker serves the next call.
      const next = await p.run({
        appId: 'app-test',
        source: 'export default function check() { return { allow: true }; }',
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      expect(next.result).toEqual({ allow: true });
    } finally {
      await p.close();
    }
  });
});

describe('an interrupt swallowed by the engine still ends the call as a timeout', () => {
  // The interrupt fires inside Error.prepareStackTrace while QuickJS builds a stack, which
  // swallows it; the hook then carried on and returned allow past its deadline.
  it('Error.prepareStackTrace looping on `new Error()`', async () => {
    const { result } = await run(
      'Error.prepareStackTrace = () => { for(;;){} }; export default function c(){ new Error("x"); return {allow:true}; }',
      { timeoutMs: 20 }
    );
    expect(result).toEqual({
      allow: false,
      cause: 'timeout',
      detail: 'interrupted at the deadline',
    });
  });

  it('Error.prepareStackTrace looping on `Error.captureStackTrace(o)`', async () => {
    const { result } = await run(
      'Error.prepareStackTrace = () => { for(;;){} }; export default function c(){ const o = {}; Error.captureStackTrace(o); o.stack; return {allow:true}; }',
      { timeoutMs: 20 }
    );
    expect(result).toEqual({
      allow: false,
      cause: 'timeout',
      detail: 'interrupted at the deadline',
    });
  });
});

describe('the deadline covers evaluation, not compilation', () => {
  // A hook that is quick to RUN: a 30,000-iteration loop, long enough that QuickJS polls the
  // interrupt handler at least once (it polls every ~10,000 operations). A first version of this
  // test (no loop) never went red: a hook that runs fewer operations than one poll interval is
  // never interrupted.
  const QUICK =
    'export default function check() { let s = 0; for (let i = 0; i < 30000; i++) s += i; return s > 0 ? { allow: true } : { allow: false, reason: "x" }; }';

  // Compile time is simulated on a virtual clock, so the verdict does not depend on how fast the
  // host compiles or how loaded it is. `performance.now()` returns the virtual time, which moves
  // ONLY when the sandbox evaluates the hook's source: by `first` ms on the compile-only pass and
  // by `second` ms on the real evaluation (its second compile). It stands still while the hook
  // runs, so the interrupt fires only if the deadline was already spent before the hook started.
  // In-process on a real QuickJS instance, the way instance.test.ts injects faults.
  const real = instantiate(compileQuickJS());
  async function evaluateOnVirtualClock(first: number, second: number, timeoutMs: number) {
    const qjs = await real;
    const clock = { now: 1_000, hookEvals: 0 };
    const clocked = {
      newRuntime: (...a: Parameters<QuickJSWASMModule['newRuntime']>) => {
        const rt = qjs.newRuntime(...a);
        const newContext = rt.newContext.bind(rt);
        rt.newContext = ((...b: Parameters<typeof newContext>) => {
          const ctx = newContext(...b);
          const evalCode = ctx.evalCode.bind(ctx);
          ctx.evalCode = ((code: string, filename?: string, options?: unknown) => {
            if (filename === 'hook.js') {
              clock.hookEvals++;
              const compileOnly =
                typeof options === 'object' && options !== null && 'compileOnly' in options
                  ? options.compileOnly === true
                  : false;
              clock.now += compileOnly ? first : second;
            }
            return evalCode(code, filename, options as Parameters<typeof evalCode>[2]);
          }) as typeof ctx.evalCode;
          return ctx;
        }) as typeof rt.newContext;
        return rt;
      },
    } as unknown as QuickJSWASMModule;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    try {
      const out = evaluateHookOn(clocked, { source: QUICK, inputJson: hookInputJson(), timeoutMs });
      return { result: out.result, hookEvals: clock.hookEvals };
    } finally {
      spy.mockRestore();
    }
  }

  // Virtual milliseconds: [first compile, second compile, timeoutMs, verdict]. The clock is
  // virtual, so each case is deterministic and runs once. The floor pair and the factor pair each
  // sit one virtual ms either side of their bound, so each pins its constant from both sides.
  const ALLOW = { result: { allow: true }, hookEvals: 2 };
  const TIMEOUT = {
    result: { allow: false, cause: 'timeout', detail: 'interrupted at the deadline' },
    hookEvals: 2,
  };
  it.each([
    // The compile is not charged to the hook: red with the deadline armed before compilation,
    // and red with an allowance of exactly the measured compile (20 + 5 <= 30).
    ['a second compile slower than the first is paid for', 20, 30, 5, ALLOW],
    // The floor alone pays for a second compile after a first that measured nothing.
    ['the floor pays for a second compile after a ~0 ms first', 0, 4, 1, ALLOW],
    ['the floor is bounded', 0, 7, 1, TIMEOUT],
    // FACTOR: 1.5 x 20 + floor + 1 lands between 35 and 37.
    ['the factor pays for a second compile 1.75x the first', 20, 35, 1, ALLOW],
    ['the factor is bounded', 20, 37, 1, TIMEOUT],
    // Positive control: the virtual clock does reach the interrupt handler.
    ['a second compile far beyond the allowance is a timeout', 20, 90, 5, TIMEOUT],
  ])('%s', async (_name, first, second, timeoutMs, expected) => {
    expect(await evaluateOnVirtualClock(first, second, timeoutMs)).toEqual(expected);
  });
});

describe('memory and stack limits', () => {
  it('refuses a 32 MiB ArrayBuffer as oom', async () => {
    const { result } = await run(
      'export default function check() { const b = new ArrayBuffer(32 * 1024 * 1024); return { allow: b.byteLength > 0 }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'oom', detail: 'out of memory' });
  });

  it('refuses a 32 MiB string as oom', async () => {
    const { result } = await run(
      'export default function check() { const s = "x".repeat(32 * 1024 * 1024); return { allow: s.length > 0 }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'oom', detail: 'out of memory' });
  });

  // oom is keyed on the engine's own InternalError, which hook code cannot construct: a look-alike
  // is an ordinary author error.
  it('a thrown look-alike of the out-of-memory error is cause error, not oom', async () => {
    const { result } = await run(
      'export default function check() { const e = new Error("out of memory"); e.name = "InternalError"; throw e; }'
    );
    expect(result).toEqual({
      allow: false,
      cause: 'error',
      detail: 'InternalError: out of memory',
    });
  });

  it('InternalError is not reachable as a global', async () => {
    const { result } = await run(
      'export default function check() { return { allow: false, reason: typeof InternalError }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'denied', reason: 'undefined' });
  });

  it('allows a 1 MiB allocation (the cap is not set at zero)', async () => {
    const { result } = await run(
      'export default function check() { const b = new ArrayBuffer(1024 * 1024); return b.byteLength === 1048576 ? { allow: true } : { allow: false, reason: "x" }; }'
    );
    expect(result).toEqual({ allow: true });
  });

  it('refuses unbounded recursion as stack_overflow', async () => {
    const { result } = await run(
      'function f(n) { return f(n + 1) + 1; }\nexport default function check() { f(0); return { allow: true }; }'
    );
    expect(result).toMatchObject({ allow: false, cause: 'stack_overflow' });
  });

  it('allows recursion 500 deep (the stack cap leaves room for real code)', async () => {
    const { result } = await run(
      'function f(n) { return n === 0 ? 0 : f(n - 1) + 1; }\nexport default function check() { return f(500) === 500 ? { allow: true } : { allow: false, reason: "x" }; }'
    );
    expect(result).toEqual({ allow: true });
  });
});

describe('no capabilities', () => {
  it.each([
    ['fetch', 'fetch("https://example.com")'],
    ['setTimeout', 'setTimeout(() => {}, 1)'],
    ['require', 'require("fs")'],
  ])('a %s reference is a ReferenceError refusal', async (name, expr) => {
    const { result } = await run(
      `export default function check() { ${expr}; return { allow: true }; }`
    );
    expect(result).toEqual({
      allow: false,
      cause: 'error',
      detail: `ReferenceError: ${name} is not defined`,
    });
  });

  it('a static import fails to load', async () => {
    const { result } = await run(
      'import fs from "fs";\nexport default function check() { return { allow: true }; }'
    );
    expect(result).toEqual({
      allow: false,
      cause: 'error',
      detail: "ReferenceError: could not load module 'fs'",
    });
  });

  it('a dynamic import yields a Promise, which is not a valid result', async () => {
    const { result } = await run('export default function check() { return import("fs"); }');
    expect(result).toMatchObject({ allow: false, cause: 'invalid_result' });
  });

  it('no host global is defined', async () => {
    const { result } = await run(
      'const names = ["fetch","setTimeout","setInterval","setImmediate","queueMicrotask","require","process","console","std","os","Deno","Bun","XMLHttpRequest","WebSocket","WebAssembly","performance","navigator","Buffer"];\n' +
        'export default function check() { const present = names.filter((n) => typeof globalThis[n] !== "undefined"); return { allow: false, reason: "present:" + present.join(",") }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'denied', reason: 'present:' });
  });
});

describe('no capabilities: positive control', () => {
  it('the same probe does report globals that exist', async () => {
    const { result } = await run(
      'const names = ["JSON","Date","fetch"];\n' +
        'export default function check() { const present = names.filter((n) => typeof globalThis[n] !== "undefined"); return { allow: false, reason: "present:" + present.join(",") }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'denied', reason: 'present:JSON,Date' });
  });
});

describe('author faults are distinct causes', () => {
  it('a throw is cause error with the message', async () => {
    const { result } = await run(
      'export default function check() { throw new TypeError("nope"); }'
    );
    expect(result).toEqual({ allow: false, cause: 'error', detail: 'TypeError: nope' });
  });

  it('a thrown non-Error value is cause error', async () => {
    const { result } = await run('export default function check() { throw 7; }');
    expect(result).toEqual({ allow: false, cause: 'error', detail: 'thrown value: 7' });
  });

  it('a syntax error is cause error', async () => {
    const { result } = await run('export default function check( { return { allow: true }; }');
    expect(result).toMatchObject({ allow: false, cause: 'error' });
    expect((result as { detail: string }).detail).toMatch(/^SyntaxError: /);
  });

  it('a module without a default export function is cause error', async () => {
    const { result } = await run('export const check = () => ({ allow: true });');
    expect(result).toEqual({
      allow: false,
      cause: 'error',
      detail: 'the module has no default export function',
    });
  });

  it('top-level await is cause error', async () => {
    const { result } = await run(
      'await 0;\nexport default function check() { return { allow: true }; }'
    );
    expect(result).toEqual({
      allow: false,
      cause: 'error',
      detail: 'top-level await is not supported (v1 hooks are synchronous)',
    });
  });

  it.each([
    ['{allow:"yes"}', '({ allow: "yes" })'],
    ['{allow:false} without a reason', '({ allow: false })'],
    ['an empty reason', '({ allow: false, reason: "" })'],
    ['a non-string reason', '({ allow: false, reason: 5 })'],
    ['{allow:true} with an extra key', '({ allow: true, extra: 1 })'],
    ['{allow:1}', '({ allow: 1 })'],
    ['null', 'null'],
    ['undefined', 'undefined'],
    ['an array', '[true]'],
    ['a function', '(() => ({ allow: true }))'],
    ['a BigInt (not serialisable)', '({ allow: true, n: 1n })'],
  ])('returning %s is invalid_result', async (_label, expr) => {
    const { result } = await run(`export default function check() { return ${expr}; }`);
    expect(result).toMatchObject({ allow: false, cause: 'invalid_result' });
  });

  it('returning a Promise is invalid_result', async () => {
    const { result } = await run(
      'export default function check() { return Promise.resolve({ allow: true }); }'
    );
    expect(result).toEqual({
      allow: false,
      cause: 'invalid_result',
      detail: 'hook returned a Promise (v1 hooks are synchronous)',
    });
  });

  it('an async hook is invalid_result', async () => {
    const { result } = await run(
      'export default async function check() { return { allow: true }; }'
    );
    expect(result).toEqual({
      allow: false,
      cause: 'invalid_result',
      detail: 'hook returned a Promise (v1 hooks are synchronous)',
    });
  });

  it('a 250-character reason is truncated to its first 200 characters', async () => {
    const { result } = await run(
      'export default function check() { return { allow: false, reason: "a".repeat(200) + "b".repeat(50) }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'denied', reason: 'a'.repeat(200) });
  });

  it('a 200-character reason is accepted (the boundary)', async () => {
    const { result } = await run(
      'export default function check() { return { allow: false, reason: "r".repeat(200) }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'denied', reason: 'r'.repeat(200) });
  });

  it('strips U+061C, U+2028, U+2029 and U+FEFF from the reason', async () => {
    const { result } = await run(
      'export default function check() { return { allow: false, reason: "a\\u061Cb\\u2028c\\u2029d\\uFEFFe" }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'denied', reason: 'abcde' });
  });

  it('strips control and bidi characters from the reason', async () => {
    const { result } = await run(
      'export default function check() { return { allow: false, reason: "a\\u0000b\\nc\\u202Ed\\u0007" }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'denied', reason: 'abcd' });
  });

  it('a hook that reassigns JSON.parse/stringify cannot change how its result is read', async () => {
    const { result } = await run(
      'JSON.stringify = () => \'{"allow":true}\';\nexport default function check() { return { allow: false, reason: "real" }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'denied', reason: 'real' });
  });
});

describe('no state between calls', () => {
  it('a global set in call 1 is absent in call 2, on the same worker', async () => {
    const p = await HookPool.start({ size: 1 });
    try {
      const source =
        'export default function check() { const seen = typeof globalThis.__mark; globalThis.__mark = 1; return seen === "undefined" ? { allow: true } : { allow: false, reason: "state carried" }; }';
      const first = await p.run({
        appId: 'app-test',
        source,
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      const second = await p.run({
        appId: 'app-test',
        source,
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      expect(first.result).toEqual({ allow: true });
      expect(second.result).toEqual({ allow: true });

      // Module-level state and prototype pollution do not carry either.
      const counter =
        'let n = 0; if (Object.prototype.__polluted) n = 100; Object.prototype.__polluted = true;\nexport default function check() { n++; return n === 1 ? { allow: true } : { allow: false, reason: "n=" + n }; }';
      const c1 = await p.run({
        appId: 'app-test',
        source: counter,
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      const c2 = await p.run({
        appId: 'app-test',
        source: counter,
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      expect(c1.result).toEqual({ allow: true });
      expect(c2.result).toEqual({ allow: true });
    } finally {
      await p.close();
    }
  });

  it('positive control: state DOES carry within one call', async () => {
    const { result } = await run(
      'let n = 0;\nfunction bump() { n++; }\nexport default function check() { bump(); bump(); return { allow: false, reason: "n=" + n }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'denied', reason: 'n=2' });
  });

  // The shared instance must not be poisoned by a call that ended badly. Pool of ONE, so every
  // call below runs on the same worker and the same WASM instance. After each bad ending the
  // probe runs normally: it allocates 8 MiB (half the cap, so a heap left over from the bad call
  // would push it over), recurses 500 deep, loops long enough to need several interrupt polls,
  // and checks that the bad call's global is gone.
  it('after an OOM, an interrupt, a stack overflow or a throw, the next call on the same worker is normal', async () => {
    const p = await HookPool.start({ size: 1 });
    const probe =
      'function f(n) { return n === 0 ? 0 : f(n - 1) + 1; }\n' +
      'export default function check() { const b = new ArrayBuffer(8 * 1024 * 1024); let s = 0; for (let i = 0; i < 200000; i++) s += i; return typeof globalThis.__bad === "undefined" && b.byteLength === 8388608 && f(500) === 500 && s > 0 ? { allow: true } : { allow: false, reason: "poisoned" }; }';
    const bad: Array<[string, string]> = [
      ['oom', 'globalThis.__bad = 1; new ArrayBuffer(32 * 1024 * 1024);'],
      ['timeout', 'globalThis.__bad = 1; for (;;) {}'],
      ['stack_overflow', 'globalThis.__bad = 1; const g = (n) => g(n + 1) + 1; g(0);'],
      ['error', 'globalThis.__bad = 1; throw new Error("x");'],
    ];
    try {
      for (const [cause, body] of bad) {
        const b = await p.run({
          appId: 'app-test',
          source: `export default function check() { ${body} return { allow: true }; }`,
          inputJson: hookInputJson(),
          timeoutMs: 20,
        });
        expect(b.result).toMatchObject({ allow: false, cause });
        const next = await p.run({
          appId: 'app-test',
          source: probe,
          inputJson: hookInputJson(),
          timeoutMs: 500,
        });
        expect({ after: cause, result: next.result }).toEqual({
          after: cause,
          result: { allow: true },
        });
      }
      expect(p.stats().terminated).toBe(0);
    } finally {
      await p.close();
    }
  });

  it('deep nesting serialised by JSON.stringify ends cleanly and the worker keeps serving', async () => {
    const p = await HookPool.start({ size: 1 });
    try {
      const deep = await p
        .run({
          appId: 'app-test',
          source:
            'export default function check() { let a = []; for (let i = 0; i < 200000; i++) a = [a]; JSON.stringify(a); return { allow: true }; }',
          inputJson: hookInputJson(),
          timeoutMs: 500,
        })
        .catch((err: unknown) => {
          // Either a backstop or a crashed worker is acceptable; an allow never is.
          expect(err instanceof BackstopError || err instanceof WorkerCrashedError).toBe(true);
          return { result: { allow: false } };
        });
      expect(deep.result).toMatchObject({ allow: false });
      const next = await p.run({
        appId: 'app-test',
        source: 'export default function check() { return { allow: true }; }',
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      expect(next.result).toEqual({ allow: true });
    } finally {
      await p.close();
    }
  });

  it('a call after an OOM on the same worker is unaffected', async () => {
    const p = await HookPool.start({ size: 1 });
    try {
      const oom = await p.run({
        appId: 'app-test',
        source:
          'export default function check() { new ArrayBuffer(32 * 1024 * 1024); return { allow: true }; }',
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      expect(oom.result).toMatchObject({ cause: 'oom' });
      const ok = await p.run({
        appId: 'app-test',
        source:
          'export default function check() { new ArrayBuffer(8 * 1024 * 1024); return { allow: true }; }',
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      expect(ok.result).toEqual({ allow: true });
    } finally {
      await p.close();
    }
  });
});

describe('per-app fairness', () => {
  const LOOP = 'export default function check() { for (;;) {} }';
  const ALLOW = 'export default function check() { return { allow: true }; }';

  it('an app at its in-flight cap gets overloaded; another app is still admitted', async () => {
    const p = await HookPool.start({ size: 1, maxQueue: 8, maxPerApp: 2 });
    try {
      const a1 = p.run({
        appId: 'app-a',
        source: LOOP,
        inputJson: hookInputJson(),
        timeoutMs: 100,
      });
      const a2 = p.run({
        appId: 'app-a',
        source: LOOP,
        inputJson: hookInputJson(),
        timeoutMs: 100,
      });
      await expect(
        p.run({ appId: 'app-a', source: ALLOW, inputJson: hookInputJson(), timeoutMs: 50 })
      ).rejects.toBeInstanceOf(PoolOverloadedError);
      const b = await p.run({
        appId: 'app-b',
        source: ALLOW,
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      expect(b.result).toEqual({ allow: true });
      await Promise.all([a1, a2]);
      // The cap counts in-flight work only: once A's calls finish, A is admitted again.
      const a3 = await p.run({
        appId: 'app-a',
        source: ALLOW,
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      expect(a3.result).toEqual({ allow: true });
    } finally {
      await p.close();
    }
  });

  it('defaults the per-app cap to a quarter of the queue, rounded up', async () => {
    const p = await HookPool.start({ size: 1, maxQueue: 6 });
    try {
      expect(p.stats().maxPerApp).toBe(2);
    } finally {
      await p.close();
    }
  });
});

describe('worker replacement and liveness', () => {
  const CRASH = new URL('../test-support/crash-worker.mjs', import.meta.url);
  const STALL =
    'export default function check() { const a = []; for (;;) a.push(new Array(1e5).fill(1)); }';

  it('a replacement worker that fails to start is retried with backoff until one starts', async () => {
    let made = 0;
    const p = await HookPool.start({
      size: 1,
      backstopMs: 20,
      respawnBaseMs: 10,
      createWorker: (url) => {
        made++;
        // 1: the initial worker. 2 and 3: replacements that crash on start. 4: a good one.
        return new Worker(made === 2 || made === 3 ? CRASH : url);
      },
    });
    try {
      await expect(
        p.run({ appId: 'app-test', source: STALL, inputJson: hookInputJson(), timeoutMs: 10 })
      ).rejects.toBeInstanceOf(BackstopError);
      const next = await p.run({
        appId: 'app-test',
        source: 'export default function check() { return { allow: true }; }',
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      expect(next.result).toEqual({ allow: true });
      expect(made).toBe(4);
      expect(p.stats().restarts).toBe(3);
    } finally {
      await p.close();
    }
  });

  it('a pool with no live worker for deadAfterMs reports not live', async () => {
    let made = 0;
    const p = await HookPool.start({
      size: 1,
      backstopMs: 20,
      respawnBaseMs: 10,
      deadAfterMs: 50,
      createWorker: (url) => new Worker(made++ === 0 ? url : CRASH),
    });
    try {
      expect(p.liveness().live).toBe(true);
      await expect(
        p.run({ appId: 'app-test', source: STALL, inputJson: hookInputJson(), timeoutMs: 10 })
      ).rejects.toBeInstanceOf(BackstopError);
      await waitFor('the pool to report not live', () => !p.liveness().live);
      expect(p.liveness()).toMatchObject({ live: false, ready: 0 });
    } finally {
      await p.close();
    }
  });
});
