import { createAxiomLogger } from '@civitai/axiom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The seam nobody owned.
 *
 * `@civitai/axiom` has its own tests proving `createAxiomLogger` reads `deps.emitLog` per
 * call, so a sink registered AFTER the logger is built still fires. `@civitai/telemetry`
 * has its own tests proving `emitOtelLog` hands a record to a registered provider. Both
 * suites were green, both were audited, and the bridge still delivered 1.3% of records in
 * production — because the defect was in neither component but in the JOIN between them:
 * the object the app hands to `createAxiomLogger` was a module-scope `const` in
 * `~/server/logging/client`, and the bundler emits that module 14 times into one server
 * build. `setStructuredLogSink()` runs once, at boot, and armed exactly one of them.
 *
 * These cases pin the RELATIONSHIP: a registration made through one module instance must
 * be observable through a DIFFERENT instance of the same module. `vi.resetModules()` is
 * what makes that expressible — it gives a second, genuinely separate module registry
 * inside one process that shares one `globalThis`, which is structurally the relationship
 * the bundler creates between two emitted copies.
 *
 * 🔴 What this CANNOT prove is how many copies the bundler actually emits — a test loads a
 * module as many times as it is told to. That half is gated at build time by
 * `scripts/check-server-graph-singletons.mjs`, which reads the real emitted source maps.
 * Neither check subsumes the other: this one pins the invariant, that one pins the fact.
 *
 * No `vi.mock` of the logger or the OTel packages anywhere below — a wholesale mock would
 * make the assertions statements about the mock, and the module under test has no runtime
 * imports at all, so there is nothing that would need stubbing.
 */

// The module holds process-wide state on `globalThis` BY DESIGN, so it leaks between test
// files unless each case starts from a known global. Clearing it here (not just resetting
// modules) is what makes the `??=` adoption case below meaningful.
const GLOBAL_KEY = '__civitaiStructuredLogSink' as const;
type SinkGlobal = typeof globalThis & {
  [GLOBAL_KEY]?: { emitLog?: (body: string, data: object, ds?: string) => void };
};

beforeEach(() => {
  delete (globalThis as SinkGlobal)[GLOBAL_KEY];
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as SinkGlobal)[GLOBAL_KEY];
});

/** Load a fresh, genuinely separate instance of the module under test. */
async function loadInstance() {
  vi.resetModules();
  return import('~/server/logging/structured-log-sink');
}

describe('structuredLogSink — cross-module-instance identity', () => {
  it('gives two SEPARATE module instances the SAME sink object', async () => {
    const a = await loadInstance();
    const b = await loadInstance();

    // Guard the premise: if these were the same module instance the test would pass
    // trivially and prove nothing about the bug.
    expect(a).not.toBe(b);
    expect(a.setStructuredLogSink).not.toBe(b.setStructuredLogSink);

    // ...and yet exactly one sink object, because it comes from globalThis.
    expect(a.structuredLogSink).toBe(b.structuredLogSink);
  });

  it('THE REGRESSION: a sink registered via instance A is visible to instance B', async () => {
    const a = await loadInstance();
    const b = await loadInstance();

    const emit = vi.fn();
    a.setStructuredLogSink(emit);

    // With a module-scope `const sink = {}` this reads `undefined` — which is precisely
    // the production failure: 13 of 14 emitted copies of the logger shim never saw the
    // boot-time registration.
    expect(b.structuredLogSink.emitLog).toBe(emit);
  });

  it('ADOPTS a pre-existing global object rather than replacing it', async () => {
    // A logger built by an earlier-evaluated copy has already closed over the object that
    // is on the global. If a later copy assigned a FRESH object, that logger would be
    // orphaned — the same bug in a different costume. `??=` is what prevents it.
    const preexisting = { emitLog: vi.fn() };
    (globalThis as SinkGlobal)[GLOBAL_KEY] = preexisting;

    const a = await loadInstance();

    expect(a.structuredLogSink).toBe(preexisting);
    expect(a.structuredLogSink.emitLog).toBe(preexisting.emitLog);
  });
});

describe('structuredLogSink — composed with the real logger', () => {
  // The end-to-end shape of the production bug, with a REAL createAxiomLogger (no mock):
  // register through one module instance, log through a logger built from another.
  //
  // `isProd: true` is required because the structured line (and therefore the injected
  // sink) is only written on the production branch; the rest is overridden so the logger
  // never constructs an Axiom client or touches the network.
  const PROD_NO_AXIOM = {
    token: undefined,
    orgId: undefined,
    datastream: 'test-stream',
    podName: 'test-pod',
    logErrorsToStdout: true,
    isProd: true,
  };

  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stderrLines: string[];
  beforeEach(() => {
    // logToAxiom writes the structured line to stderr unconditionally; capture instead of
    // printing so the suite output stays readable. Capturing (rather than discarding) is
    // what lets the case below assert that the sink got the SAME string stderr did.
    stderrLines = [];
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderrLines.push(String(args[0]));
    });
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('a logger built from instance B fires a sink registered through instance A', async () => {
    const a = await loadInstance();
    const b = await loadInstance();

    const received: string[] = [];
    a.setStructuredLogSink((body) => {
      received.push(body);
    });

    // Built from B's view of the sink — a different module instance than the registrar.
    const { logToAxiom } = createAxiomLogger(PROD_NO_AXIOM, b.structuredLogSink);
    await logToAxiom({ type: 'error', name: 'seam-check' });

    expect(received).toHaveLength(1);
    // The sink's body is the SAME string the stderr write got — one serialization, N
    // sinks. Asserting the content (not just the call count) keeps this from passing on a
    // sink that fires with the wrong payload.
    expect(received[0]).toContain('"name":"seam-check"');
    expect(stderrLines).toEqual([received[0]]);
  });

  it('registration ORDER does not matter: a logger built BEFORE the registration still fires', async () => {
    const a = await loadInstance();
    const b = await loadInstance();

    // This is the real boot order: the shim's module-scope `logToAxiom` is constructed
    // when the module is first evaluated, and `src/instrumentation.node.ts` registers the
    // OTel sink afterwards.
    const { logToAxiom } = createAxiomLogger(PROD_NO_AXIOM, b.structuredLogSink);

    const received: string[] = [];
    a.setStructuredLogSink((body) => {
      received.push(body);
    });

    await logToAxiom({ type: 'info', name: 'late-registration' });
    expect(received).toHaveLength(1);
  });
});
