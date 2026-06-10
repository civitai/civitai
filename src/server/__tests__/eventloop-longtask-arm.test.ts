import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import client from 'prom-client';

// ---------------------------------------------------------------------------
// WHY THIS TEST EXISTS
//
// The cost contract of the detector is tier-gated:
//   (1) DISARMED (THRESHOLD_MS unset/<=0): NOTHING installed — zero async_hooks,
//       zero wrapper. Byte-for-byte the pre-instrumentation path.
//   (2) BASE ARMED (THRESHOLD_MS>0, no LABELS): lag gauge + drift timer only —
//       still NO async_hooks (the OTEL-class cost the team removed).
//   (3) LABELS ARMED (+EVENTLOOP_LONGTASK_LABELS=true): the async_hooks attribution
//       path activates — exactly ONE createHook for the label hook.
//
// async_hooks is the expensive bit, so this test pins WHEN createHook is installed by
// spying on node:async_hooks.createHook across the three tiers. It mocks
// node:async_hooks to count createHook while preserving real AsyncLocalStorage so the
// label-propagation semantics are unchanged.
// ---------------------------------------------------------------------------

const { createHookCalls } = vi.hoisted(() => ({ createHookCalls: { count: 0 } }));

vi.mock('node:async_hooks', async () => {
  const actual = await vi.importActual<typeof import('node:async_hooks')>('node:async_hooks');
  return {
    ...actual,
    createHook: (callbacks: Parameters<typeof actual.createHook>[0]) => {
      createHookCalls.count++;
      return actual.createHook(callbacks);
    },
  };
});

const { armTestRegistry } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const promClient = require('prom-client');
  return { armTestRegistry: new promClient.Registry() as client.Registry };
});

vi.mock('~/server/prom/client', () => {
  function registerInstrumentationMetric<M extends client.Metric<string>>(
    name: string,
    factory: () => M
  ): M {
    const existing = armTestRegistry.getSingleMetric(name);
    if (existing) return existing as unknown as M;
    return factory();
  }
  return {
    instrumentationRegistry: armTestRegistry,
    registerInstrumentationMetric,
    registerCounter: () => ({ inc: vi.fn() }),
    registerHistogram: () => ({ observe: vi.fn() }),
  };
});

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

// The arm function settles `armed` once per process; re-import a FRESH module per
// tier via vi.resetModules so each env config arms from scratch.
const ENV_KEYS = [
  'EVENTLOOP_LONGTASK_THRESHOLD_MS',
  'EVENTLOOP_LONGTASK_LABELS',
  'EVENTLOOP_LONGTASK_STACKS',
  'NEXT_RUNTIME',
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

async function armWith(env: Record<string, string>): Promise<number> {
  clearEnv();
  Object.assign(process.env, env);
  createHookCalls.count = 0;
  vi.resetModules();
  const mod = await import('~/server/eventloop-longtask');
  mod.registerEventLoopLongTaskDetector();
  return createHookCalls.count;
}

describe('eventloop-longtask arm: async_hooks are installed ONLY for the labels/stacks tiers', () => {
  beforeEach(() => clearEnv());
  afterEach(() => clearEnv());

  it('(1) DISARMED installs no async_hooks (zero createHook calls)', async () => {
    expect(await armWith({})).toBe(0);
  });

  it('(1) DISARMED with THRESHOLD_MS=0 installs no async_hooks', async () => {
    expect(await armWith({ EVENTLOOP_LONGTASK_THRESHOLD_MS: '0' })).toBe(0);
  });

  it('(2) BASE ARMED (threshold set, no LABELS) installs NO async_hooks', async () => {
    expect(await armWith({ EVENTLOOP_LONGTASK_THRESHOLD_MS: '50' })).toBe(0);
  });

  it('(3) LABELS armed installs exactly ONE async_hooks hook (the label hook)', async () => {
    expect(
      await armWith({ EVENTLOOP_LONGTASK_THRESHOLD_MS: '50', EVENTLOOP_LONGTASK_LABELS: 'true' })
    ).toBe(1);
  });

  it('LABELS requires armed: LABELS=true with no threshold stays disarmed (no hook)', async () => {
    expect(await armWith({ EVENTLOOP_LONGTASK_LABELS: 'true' })).toBe(0);
  });

  it('off the nodejs runtime nothing arms (no hook) even with labels requested', async () => {
    expect(
      await armWith({
        NEXT_RUNTIME: 'edge',
        EVENTLOOP_LONGTASK_THRESHOLD_MS: '50',
        EVENTLOOP_LONGTASK_LABELS: 'true',
      })
    ).toBe(0);
  });

  it('base-armed sets longTaskLabelsArmed=false; labels-armed sets it true', async () => {
    clearEnv();
    process.env.EVENTLOOP_LONGTASK_THRESHOLD_MS = '50';
    vi.resetModules();
    const baseMod = await import('~/server/eventloop-longtask');
    baseMod.registerEventLoopLongTaskDetector();
    expect(baseMod.longTaskLabelsArmed).toBe(false);

    clearEnv();
    process.env.EVENTLOOP_LONGTASK_THRESHOLD_MS = '50';
    process.env.EVENTLOOP_LONGTASK_LABELS = 'true';
    vi.resetModules();
    const labelMod = await import('~/server/eventloop-longtask');
    labelMod.registerEventLoopLongTaskDetector();
    expect(labelMod.longTaskLabelsArmed).toBe(true);
  });
});
