import { describe, expect, it } from 'vitest';
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import {
  QuickJSInstance,
  SandboxDisposeError,
  SandboxSetupError,
  compileQuickJS,
  evaluateOn,
  instantiate,
  loadModule,
} from '../sandbox.ts';
import { evaluateRemix } from '../remix.ts';
import { hookInputJson } from '../test-support/fixtures.ts';

/**
 * The shared-instance policy: one WASM instance serves a worker's calls, and it is replaced only
 * after a call that may have left it unsafe. Hook code CAN reach some unsafe endings (a review
 * poisoned an instance on the main thread with 200k-deep nesting serialised by JSON.stringify,
 * which overflowed the host stack), but not reliably on every host, so here they are injected
 * around a REAL instance to pin the policy deterministically.
 */

const compiled = compileQuickJS();
const ALLOW = {
  source: 'export default function check() { return { allow: true }; }',
  inputJson: hookInputJson(),
  timeoutMs: 50,
};
const OOM = {
  source:
    'export default function check() { new ArrayBuffer(32 * 1024 * 1024); return { allow: true }; }',
  inputJson: hookInputJson(),
  timeoutMs: 50,
};
const LOOP = {
  source: 'export default function check() { for (;;) {} }',
  inputJson: hookInputJson(),
  timeoutMs: 5,
};

/** A real instance whose runtimes fail to dispose, as a QuickJS assertion would. */
async function disposeFails(): Promise<QuickJSWASMModule> {
  const real = await instantiate(compiled);
  return {
    newRuntime: (...a: Parameters<QuickJSWASMModule['newRuntime']>) => {
      const rt = real.newRuntime(...a);
      const dispose = rt.dispose.bind(rt);
      rt.dispose = () => {
        dispose();
        throw new Error('injected: assertion on leaked objects');
      };
      return rt;
    },
  } as unknown as QuickJSWASMModule;
}

describe('QuickJSInstance', () => {
  it('keeps ONE instance across normal calls and clean in-VM failures (oom, interrupt)', async () => {
    const inst = QuickJSInstance.fromCompiled(compiled);
    expect((await inst.evaluate(ALLOW)).result).toEqual({ allow: true });
    expect((await inst.evaluate(OOM)).result).toMatchObject({ cause: 'oom' });
    expect((await inst.evaluate(LOOP)).result).toMatchObject({ cause: 'timeout' });
    const last = await inst.evaluate(ALLOW);
    expect(last).toMatchObject({ result: { allow: true }, poisoned: false });
    expect(inst.created).toBe(1);
  });

  // Fail closed: a call whose disposal failed is a RUNNER fault. Its computed answer (here an
  // allow) is never returned; the worker answers 500 and the caller says hook_unavailable.
  it('rejects a call whose disposal failed, never returning its allow, and replaces the instance', async () => {
    let made = 0;
    const inst = new QuickJSInstance(async () => {
      made++;
      return made === 1 ? disposeFails() : instantiate(compiled);
    });
    await expect(inst.evaluate(ALLOW)).rejects.toBeInstanceOf(SandboxDisposeError);
    const second = await inst.evaluate(ALLOW);
    expect(second).toMatchObject({ result: { allow: true }, poisoned: false });
    expect(inst.created).toBe(2);
  });

  it('replaces the instance after a throw out of the WASM boundary', async () => {
    let made = 0;
    const inst = new QuickJSInstance(async () => {
      made++;
      if (made > 1) return instantiate(compiled);
      const real = await instantiate(compiled);
      return {
        newRuntime: (...a: Parameters<QuickJSWASMModule['newRuntime']>) => {
          const rt = real.newRuntime(...a);
          const newContext = rt.newContext.bind(rt);
          rt.newContext = (...c: Parameters<typeof rt.newContext>) => {
            const ctx = newContext(...c);
            ctx.evalCode = () => {
              throw new WebAssembly.RuntimeError('injected: unreachable');
            };
            return ctx;
          };
          return rt;
        },
      } as unknown as QuickJSWASMModule;
    });
    const first = await inst.evaluate(ALLOW);
    expect(first).toMatchObject({
      result: { allow: false, cause: 'error', detail: 'sandbox trap: RuntimeError' },
      poisoned: true,
    });
    expect((await inst.evaluate(ALLOW)).result).toEqual({ allow: true });
    expect(inst.created).toBe(2);
  });

  it('drops a rejected instantiation so the next call creates a new instance', async () => {
    let made = 0;
    const inst = new QuickJSInstance(async () => {
      made++;
      if (made === 1) throw new Error('injected: instantiate failed');
      return instantiate(compiled);
    });
    await expect(inst.evaluate(ALLOW)).rejects.toThrow('injected: instantiate failed');
    expect((await inst.evaluate(ALLOW)).result).toEqual({ allow: true });
    expect(inst.created).toBe(2);
  });

  it('drops the instance and rethrows when a runtime cannot be created', async () => {
    let made = 0;
    const inst = new QuickJSInstance(async () => {
      made++;
      if (made > 1) return instantiate(compiled);
      return {
        newRuntime: () => {
          throw new Error('injected: cannot create runtime');
        },
      } as unknown as QuickJSWASMModule;
    });
    await expect(inst.evaluate(ALLOW)).rejects.toThrow('injected: cannot create runtime');
    expect((await inst.evaluate(ALLOW)).result).toEqual({ allow: true });
    expect(inst.created).toBe(2);
  });
});

describe('remix instances', () => {
  const IMAGE = { imageId: 1, url: 'https://image.example/s.png', width: 1, height: 1 };
  const ASKS = {
    source:
      'export default defineRemixApp({ async run(ctx) { await ctx.ask({ kind: "text", prompt: "p", maxLength: 9 }); return []; } });',
    image: IMAGE,
    logs: [[], []],
  };

  /** Real instances, each tagged; `used` lists the tag of the instance each runtime came from. */
  function tagged(poisonFirst = false) {
    const used: number[] = [];
    let made = 0;
    const create = async () => {
      const tag = ++made;
      const real = await instantiate(compiled);
      return {
        newRuntime: (...a: Parameters<QuickJSWASMModule['newRuntime']>) => {
          used.push(tag);
          const rt = real.newRuntime(...a);
          if (poisonFirst && tag === 1) {
            const newContext = rt.newContext.bind(rt);
            rt.newContext = (...c: Parameters<typeof rt.newContext>) => {
              const ctx = newContext(...c);
              ctx.evalCode = () => {
                throw new WebAssembly.RuntimeError('injected: unreachable');
              };
              return ctx;
            };
          }
          return rt;
        },
      } as unknown as QuickJSWASMModule;
    };
    return { used, create };
  }

  it("gives every call a fresh instance, shared by that call's replays", async () => {
    const { used, create } = tagged();
    await evaluateRemix(compiled, ASKS, create);
    await evaluateRemix(compiled, ASKS, create);
    expect(used).toEqual([1, 1, 2, 2]);
  });

  it('replaces the instance after a replay that threw out of the WASM boundary', async () => {
    const { used, create } = tagged(true);
    const { results } = await evaluateRemix(compiled, ASKS, create);
    expect(results[0]).toEqual({ cause: 'error', detail: 'sandbox trap: RuntimeError' });
    // The next replay ran on a new instance, and answered normally.
    expect(results[1]).toEqual({ effects: [expect.objectContaining({ type: 'ask' })] });
    expect(used).toEqual([1, 2]);
  });
});

describe('the trusted setup', () => {
  // The remix prelude runs here; a QuickJS change that broke it would otherwise read as every
  // app's `error` while /readyz stayed 200.
  it('a prelude that fails throws "sandbox setup failed", never an author fault', async () => {
    const qjs = await instantiate(compiled);
    const load = (prelude: string) =>
      evaluateOn(qjs, 50, (scope) => {
        const loaded = loadModule(scope, 'export default 1;', prelude);
        return 'allow' in loaded ? loaded : { loaded: true };
      });
    expect(() => load('throw new TypeError("prelude broke");')).toThrow(SandboxSetupError);
    expect(() => load('throw new TypeError("prelude broke");')).toThrow('sandbox setup failed');
    // POSITIVE CONTROL: the same load with a prelude that runs.
    expect(load('globalThis.ok = 1;').result).toEqual({ loaded: true });
  });
});

declare const WebAssembly: { RuntimeError: new (message: string) => Error };
