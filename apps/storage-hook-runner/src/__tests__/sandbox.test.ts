import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKSTOP_MS } from '../limits.ts';
import { HookPool } from '../pool.ts';
import { hookInputJson } from '../test-support/fixtures.ts';

/**
 * The sandbox, exercised the way the runner uses it: through the real worker pool, so every
 * case runs in a real worker_thread on a fresh QuickJS WASM instance.
 */

let pool: HookPool;
beforeAll(async () => {
  pool = await HookPool.start({ size: 2 });
});
afterAll(async () => {
  await pool.close();
});

const run = (source: string, opts: { timeoutMs?: number; input?: string } = {}) =>
  pool.run({ source, inputJson: opts.input ?? hookInputJson(), timeoutMs: opts.timeoutMs ?? 50 });

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
  // INTERRUPT HANDLER's: the backstop also answers `timeout`, so the cause alone would not show
  // that the handler fired.
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
    expect(out.elapsedMs).toBeLessThan(ms + 40);
    expect(wall).toBeLessThan(ms + BACKSTOP_MS);
    expect(pool.stats().terminated).toBe(terminatedBefore);
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
  it('terminates a worker stuck in native code that never polls the interrupt, and recovers', async () => {
    // Measured locally: this loop spends ~1.3 s in allocation/GC near the memory cap with a
    // single interrupt poll. A pool with a 20 ms backstop must cut it at ~30 ms.
    const p = await HookPool.start({ size: 1, backstopMs: 20 });
    try {
      const t0 = performance.now();
      const out = await p.run({
        source:
          'export default function check() { const a = []; for (;;) a.push(new Array(1e5).fill(1)); }',
        inputJson: hookInputJson(),
        timeoutMs: 10,
      });
      const wall = performance.now() - t0;
      expect(out.result).toEqual({
        allow: false,
        cause: 'timeout',
        detail: 'terminated by the worker backstop',
      });
      expect(wall).toBeLessThan(500);
      expect(p.stats().terminated).toBe(1);

      // The replacement worker serves the next call.
      const next = await p.run({
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
    ['a 201-character reason', '({ allow: false, reason: "r".repeat(201) })'],
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

  it('a 200-character reason is accepted (the boundary)', async () => {
    const { result } = await run(
      'export default function check() { return { allow: false, reason: "r".repeat(200) }; }'
    );
    expect(result).toEqual({ allow: false, cause: 'denied', reason: 'r'.repeat(200) });
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
      const first = await p.run({ source, inputJson: hookInputJson(), timeoutMs: 50 });
      const second = await p.run({ source, inputJson: hookInputJson(), timeoutMs: 50 });
      expect(first.result).toEqual({ allow: true });
      expect(second.result).toEqual({ allow: true });

      // Module-level state and prototype pollution do not carry either.
      const counter =
        'let n = 0; if (Object.prototype.__polluted) n = 100; Object.prototype.__polluted = true;\nexport default function check() { n++; return n === 1 ? { allow: true } : { allow: false, reason: "n=" + n }; }';
      const c1 = await p.run({ source: counter, inputJson: hookInputJson(), timeoutMs: 50 });
      const c2 = await p.run({ source: counter, inputJson: hookInputJson(), timeoutMs: 50 });
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

  it('a call after an OOM on the same worker is unaffected', async () => {
    const p = await HookPool.start({ size: 1 });
    try {
      const oom = await p.run({
        source:
          'export default function check() { new ArrayBuffer(32 * 1024 * 1024); return { allow: true }; }',
        inputJson: hookInputJson(),
        timeoutMs: 50,
      });
      expect(oom.result).toMatchObject({ cause: 'oom' });
      const ok = await p.run({
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
