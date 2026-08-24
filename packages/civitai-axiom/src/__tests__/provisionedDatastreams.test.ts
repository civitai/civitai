import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAxiomLogger } from '../client';
import {
  PROVISIONED_AXIOM_DATASTREAMS,
  buildProvisionedDatastreams,
  parseExtraDatastreams,
} from '../datastreams';

/**
 * THE RELATIONSHIP: a datastream that reaches `axiom.ingestEvents` is one that is supposed to exist.
 *
 * 🔴 These assertions are deliberately NOT written as "we never pass `eventloop-longtask`". That
 * spelling is what let the defect ship in the first place — the property is not about any
 * particular name, it is about the relationship between the name and the set of datasets that
 * exist. A test naming the dead streams passes the moment someone renames one, and says nothing
 * about the twelfth stream nobody has added yet. So every case below is driven off
 * `provisionedDatastreams` membership, with the fixture names chosen to be arbitrary.
 *
 * The paired half of the relationship — that the datastream literals actually written in the app's
 * source are all accounted for — cannot live in this package (it does not import the app). It is
 * pinned by the call-site ledger at
 * `src/server/logging/__tests__/axiom-datastream-ledger.test.ts`.
 */

const h = vi.hoisted(() => ({ ingestEvents: vi.fn() }));
vi.mock('@axiomhq/axiom-node', () => ({
  Client: class {
    ingestEvents = h.ingestEvents;
  },
}));

const ERR = { name: 'some-event', message: 'boom' };

/**
 * Both globalThis-pinned maps the client keeps, reset between tests for the reason documented in
 * ./logToAxiom.test.ts: they are shared across every emitted copy of the module by design, so a
 * test that does not clear them reads state the previous test created. The unprovisioned-report set
 * matters here specifically — it is what makes the report fire once per process.
 */
const INGEST_FAILURES_KEY = Symbol.for('@civitai/axiom.ingestFailuresByDatastream');
const UNPROVISIONED_REPORTED_KEY = Symbol.for('@civitai/axiom.unprovisionedDatastreamsReported');
function resetSharedState() {
  (globalThis as Record<symbol, unknown>)[INGEST_FAILURES_KEY] = new Map<string, number>();
  (globalThis as Record<symbol, unknown>)[UNPROVISIONED_REPORTED_KEY] = new Set<string>();
}

/**
 * A two-element allowlist and two names outside it. Nothing here is a real dataset name: the guard
 * must be driven by SET MEMBERSHIP, so a fixture that happened to match production would make a
 * hardcoded-literal implementation pass.
 */
const ALLOWED_A = 'fixture-provisioned-a';
const ALLOWED_B = 'fixture-provisioned-b';
const ABSENT_A = 'fixture-absent-a';
const ABSENT_B = 'fixture-absent-b';

const BASE = {
  isProd: true,
  token: 'token',
  orgId: 'org',
  datastream: ALLOWED_A,
  podName: 'pod-test',
  provisionedDatastreams: new Set([ALLOWED_A, ALLOWED_B]) as ReadonlySet<string>,
} as const;

/**
 * The `axiom-*` control lines this logger writes to stderr, parsed. Typed the same way as the
 * sibling helper in ./logToAxiom.test.ts: `spy.mock.calls` is loosely typed, so the cast is what
 * keeps `tsc --noEmit` (which DOES cover packages/**) green.
 */
function reports(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const call of spy.mock.calls as unknown[][]) {
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(call[0] as string);
    } catch {
      continue;
    }
    if (typeof line.name === 'string' && line.name.startsWith('axiom-')) parsed.push(line);
  }
  return parsed;
}

describe('the provisioned-dataset guard on the Axiom dual-write', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetSharedState();
    h.ingestEvents.mockReset().mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  // ================================================================
  // The relationship itself, both directions
  // ================================================================

  it.each([
    { datastream: ALLOWED_A, provisioned: true },
    { datastream: ALLOWED_B, provisioned: true },
    { datastream: ABSENT_A, provisioned: false },
    { datastream: ABSENT_B, provisioned: false },
  ])(
    'RELATIONSHIP: ingestEvents is called for $datastream iff it is in provisionedDatastreams (expected: $provisioned)',
    async ({ datastream, provisioned }) => {
      const { logToAxiom } = createAxiomLogger(BASE);

      await logToAxiom(ERR, datastream);

      expect(BASE.provisionedDatastreams.has(datastream)).toBe(provisioned);
      if (provisioned) {
        expect(h.ingestEvents).toHaveBeenCalledTimes(1);
        expect(h.ingestEvents).toHaveBeenCalledWith(datastream, expect.anything());
      } else {
        expect(h.ingestEvents).not.toHaveBeenCalled();
      }
    }
  );

  it('RELATIONSHIP: every datastream that reaches ingestEvents across a mixed batch is provisioned', async () => {
    const { logToAxiom } = createAxiomLogger(BASE);

    for (const ds of [ABSENT_A, ALLOWED_A, ABSENT_B, ALLOWED_B, ABSENT_A]) {
      await logToAxiom(ERR, ds);
    }

    const targeted = h.ingestEvents.mock.calls.map(([ds]) => ds as string);
    // The load-bearing assertion: not "these two names", but "nothing outside the set got through".
    const leaked = targeted.filter((ds) => !BASE.provisionedDatastreams.has(ds));
    expect(leaked).toEqual([]);
    // ...and a positive control, so a guard that blocks EVERYTHING cannot pass the line above.
    expect(targeted).toEqual([ALLOWED_A, ALLOWED_B]);
  });

  it('the DEFAULT datastream is held to the same rule as an explicit one', async () => {
    const { logToAxiom } = createAxiomLogger({ ...BASE, datastream: ABSENT_A });

    await logToAxiom(ERR); // no explicit datastream — falls back to config.datastream

    expect(h.ingestEvents).not.toHaveBeenCalled();
    expect(reports(errorSpy).map((r) => r.name)).toContain('axiom-datastream-unprovisioned');
  });

  // ================================================================
  // What the skip must NOT break
  // ================================================================

  it('the event still reaches the stderr/log-store path in full, keeping its _axiom label', async () => {
    const { logToAxiom } = createAxiomLogger(BASE);

    await logToAxiom({ ...ERR, durationMs: 1485 }, ABSENT_A);

    const line = JSON.parse(errorSpy.mock.calls[0][0] as string);
    // 🔴 The whole justification for skipping rather than redirecting: the payload survives AND it
    // keeps the datastream name in `_axiom`, which is the field log queries group these streams by.
    // Dropping the argument instead would rewrite this to the default and break those queries.
    expect(line).toMatchObject({
      _axiom: ABSENT_A,
      name: ERR.name,
      message: ERR.message,
      durationMs: 1485,
      pod: 'pod-test',
    });
    expect(h.ingestEvents).not.toHaveBeenCalled();
  });

  it('an injected sink still receives the event for an unprovisioned datastream', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const { logToAxiom } = createAxiomLogger(BASE, {
      emitLog: (body, _data, datastream) => seen.push([body, datastream]),
    });

    await logToAxiom(ERR, ABSENT_A);

    expect(seen).toHaveLength(1);
    expect(seen[0][1]).toBe(ABSENT_A);
  });

  it('a skip is NOT counted as an ingest failure — the wedged-ingest counter must stay clean', async () => {
    const { logToAxiom } = createAxiomLogger(BASE);

    for (let i = 0; i < 5; i++) await logToAxiom(ERR, ABSENT_A);

    // 🔴 A permanently-dead datastream reported as a failure would pin its consecutive-failure
    // count at "always rising, never recovering" forever, which is the signal the ingest-wedged
    // alerting reads. Nothing failed here; we declined a write we know is rejected.
    expect(reports(errorSpy).map((r) => r.name)).not.toContain('axiom-ingest-failed');
    const counts = (globalThis as Record<symbol, unknown>)[INGEST_FAILURES_KEY] as Map<
      string,
      number
    >;
    expect(counts.get(ABSENT_A)).toBeUndefined();
  });

  it('a provisioned datastream still records ingest failures normally', async () => {
    h.ingestEvents.mockRejectedValue(new Error('axiom down'));
    const { logToAxiom } = createAxiomLogger(BASE);

    await logToAxiom(ERR, ALLOWED_A);

    // Positive control for the assertion above: the failure path is reachable and still works, so
    // "no axiom-ingest-failed" for the skipped stream is a real result, not a dead probe.
    expect(reports(errorSpy).map((r) => r.name)).toContain('axiom-ingest-failed');
  });

  // ================================================================
  // Diagnosability — the half of the defect that made it invisible
  // ================================================================

  it('reports an unprovisioned datastream ONCE per name per process, naming the datastream', async () => {
    const { logToAxiom } = createAxiomLogger(BASE);

    for (let i = 0; i < 4; i++) await logToAxiom(ERR, ABSENT_A);
    await logToAxiom(ERR, ABSENT_B);

    const skips = reports(errorSpy).filter((r) => r.name === 'axiom-datastream-unprovisioned');
    expect(skips.map((r) => r.datastream)).toEqual([ABSENT_A, ABSENT_B]);
    expect(skips[0]).toMatchObject({ type: 'error', pod: 'pod-test' });
    expect(String(skips[0].message)).toMatch(/no axiom dataset/i);
  });

  it('the once-per-name report is shared across separate loggers (bundler emits this module N times)', async () => {
    const a = createAxiomLogger(BASE);
    const b = createAxiomLogger(BASE);

    await a.logToAxiom(ERR, ABSENT_A);
    await b.logToAxiom(ERR, ABSENT_A);

    const skips = reports(errorSpy).filter((r) => r.name === 'axiom-datastream-unprovisioned');
    expect(skips).toHaveLength(1);
  });

  it('is inert outside production — the non-prod branch never reaches the guard', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { logToAxiom } = createAxiomLogger({ ...BASE, isProd: false });

    await logToAxiom(ERR, ABSENT_A);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });
});

describe('the provisioned-dataset allowlist', () => {
  it('AXIOM_EXTRA_DATASTREAMS can only WIDEN the set, never narrow it', () => {
    const widened = buildProvisionedDatastreams(['brand-new-dataset']);

    for (const name of PROVISIONED_AXIOM_DATASTREAMS) expect(widened.has(name)).toBe(true);
    expect(widened.has('brand-new-dataset')).toBe(true);
    expect(widened.size).toBe(PROVISIONED_AXIOM_DATASTREAMS.size + 1);
  });

  it('an empty or absent extras value leaves the snapshot untouched', () => {
    expect(buildProvisionedDatastreams(parseExtraDatastreams(undefined)).size).toBe(
      PROVISIONED_AXIOM_DATASTREAMS.size
    );
    expect(buildProvisionedDatastreams(parseExtraDatastreams('  ,, ')).size).toBe(
      PROVISIONED_AXIOM_DATASTREAMS.size
    );
  });

  it('parses a comma-separated list, trimming whitespace and dropping empties', () => {
    expect(parseExtraDatastreams(' a , b ,,c,  ')).toEqual(['a', 'b', 'c']);
  });
});
