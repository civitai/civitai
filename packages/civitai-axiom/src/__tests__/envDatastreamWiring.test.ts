import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 SEAM GUARD: the allowlist must actually reach the config object the guard reads.
 *
 * Every other test in this package is scoped to ONE surface. `provisionedDatastreams.test.ts`
 * drives the guard with an injected two-element fixture set; `axiom-datastream-ledger.test.ts`
 * imports `PROVISIONED_AXIOM_DATASTREAMS` directly. Both are hermetic, both pass, and NEITHER ever
 * builds the combined state — so the wiring BETWEEN them, the one line in `./env` that puts the
 * real snapshot onto `AxiomConfig`, had no witness at all.
 *
 * That was measured, not theorised. Two mutations of that line survived the entire suite green:
 *   - `provisionedDatastreams: new Set<string>()`      → 47/47 tests still passed
 *   - `buildProvisionedDatastreams()` (extras dropped) → 47/47 tests still passed
 *
 * 🔴 WHY THIS IS THE WORST FAILURE IN THE CHANGE, and why it earns its own file. If that wiring
 * breaks, the guard rejects EVERYTHING — `civitai-prod`, `notifications`, `clickhouse` and
 * `webhooks` included — so every Axiom write in every deployment is skipped. And it is silent BY
 * DESIGN: the skip path deliberately does not touch `consecutiveFailures`, precisely so a dead
 * datastream cannot pin the ingest-wedged alert. That same deliberate quietness means a total Axiom
 * outage would page nobody. The events would still reach the log store, so the only observable is
 * an absence in Axiom that nothing watches.
 *
 * So these tests drive `loadAxiomEnv()` and the real factory with NO `provisionedDatastreams`
 * override. `isProd`/`token`/`orgId` ARE overridden — they are not the seam, and forcing NODE_ENV
 * inside a test run has side effects well beyond this file.
 *
 * MECHANICS. `loadAxiomEnv` memoises into a module-scope `let`, so a test that mutates
 * `process.env` and calls it again gets the PREVIOUS parse — which would make every assertion below
 * a fact about the first test that ran. Each case therefore does `vi.resetModules()` and imports
 * fresh. That is also why the import is dynamic rather than top-of-file.
 */

const h = vi.hoisted(() => ({ ingestEvents: vi.fn() }));
vi.mock('@axiomhq/axiom-node', () => ({
  Client: class {
    ingestEvents = h.ingestEvents;
  },
}));

const INGEST_FAILURES_KEY = Symbol.for('@civitai/axiom.ingestFailuresByDatastream');
const UNPROVISIONED_REPORTED_KEY = Symbol.for('@civitai/axiom.unprovisionedDatastreamsReported');

const ENV_KEYS = ['AXIOM_TOKEN', 'AXIOM_ORG_ID', 'AXIOM_DATASTREAM', 'AXIOM_EXTRA_DATASTREAMS'];
let saved: Record<string, string | undefined> = {};

/** A name that is deliberately NOT in the provisioned snapshot, so extras have something to add. */
const EXTRA = 'fixture-extra-dataset';
/** A name in neither the snapshot nor the extras — the control. */
const ABSENT = 'fixture-never-provisioned';

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  (globalThis as Record<symbol, unknown>)[INGEST_FAILURES_KEY] = new Map<string, number>();
  (globalThis as Record<symbol, unknown>)[UNPROVISIONED_REPORTED_KEY] = new Set<string>();
  h.ingestEvents.mockReset().mockResolvedValue(undefined);
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

/** Import the package fresh, after `process.env` has been arranged for this case. */
async function loadFresh() {
  const [env, client] = await Promise.all([import('../env'), import('../client')]);
  return { ...env, ...client };
}

/**
 * A logger whose `provisionedDatastreams` comes from `loadAxiomEnv()` — the whole point of the
 * file. Only the fields that are NOT the seam are overridden.
 */
async function realWiredLogger() {
  process.env.AXIOM_TOKEN = 'token';
  process.env.AXIOM_ORG_ID = 'org';
  const mod = await loadFresh();
  return {
    ...mod,
    logger: mod.createAxiomLogger({ isProd: true, podName: 'pod-test' }),
  };
}

describe('the allowlist is actually wired onto the config the guard reads', () => {
  it('loadAxiomEnv() exposes the real provisioned snapshot, not an empty or partial set', async () => {
    const { loadAxiomEnv, PROVISIONED_AXIOM_DATASTREAMS } = await loadFresh();

    const { provisionedDatastreams } = loadAxiomEnv();

    // 🔴 Equality, not "contains civitai-prod". A `has()` spot-check passes against a hand-written
    // one-element set, which is the shape of the mutant this exists to kill.
    expect([...provisionedDatastreams].sort()).toEqual([...PROVISIONED_AXIOM_DATASTREAMS].sort());
    expect(provisionedDatastreams.size).toBe(PROVISIONED_AXIOM_DATASTREAMS.size);
    expect(provisionedDatastreams.size).toBeGreaterThan(1);
  });

  it('AXIOM_EXTRA_DATASTREAMS widens what the config exposes', async () => {
    process.env.AXIOM_EXTRA_DATASTREAMS = `${EXTRA}, another-extra`;
    const { loadAxiomEnv, PROVISIONED_AXIOM_DATASTREAMS } = await loadFresh();

    const { provisionedDatastreams } = loadAxiomEnv();

    expect(provisionedDatastreams.has(EXTRA)).toBe(true);
    expect(provisionedDatastreams.has('another-extra')).toBe(true);
    // Add-only: the snapshot survives intact alongside the extras.
    for (const name of PROVISIONED_AXIOM_DATASTREAMS) {
      expect(provisionedDatastreams.has(name)).toBe(true);
    }
    expect(provisionedDatastreams.size).toBe(PROVISIONED_AXIOM_DATASTREAMS.size + 2);
  });

  it('END TO END: a provisioned datastream reaches ingestEvents through the REAL env wiring', async () => {
    const { logger, PROVISIONED_AXIOM_DATASTREAMS } = await realWiredLogger();
    const provisioned = [...PROVISIONED_AXIOM_DATASTREAMS][0];

    await logger.logToAxiom({ name: 'seam-probe' }, provisioned);

    // If the wiring is broken to an empty set, this is 0 — which is the total-outage mutant.
    expect(h.ingestEvents).toHaveBeenCalledTimes(1);
    expect(h.ingestEvents).toHaveBeenCalledWith(provisioned, expect.anything());
  });

  it('END TO END: every provisioned name is admitted through the real wiring, not just one', async () => {
    const { logger, PROVISIONED_AXIOM_DATASTREAMS } = await realWiredLogger();
    const all = [...PROVISIONED_AXIOM_DATASTREAMS];

    for (const name of all) await logger.logToAxiom({ name: 'seam-probe' }, name);

    // A partially-wired set (one name, a stale subset) passes the single-name case above and dies
    // here. Asserted as the full set, so it fails whether the wiring is too narrow OR too wide.
    expect(h.ingestEvents.mock.calls.map(([ds]) => ds as string).sort()).toEqual([...all].sort());
  });

  it('END TO END: AXIOM_EXTRA_DATASTREAMS admits a name the snapshot does not contain', async () => {
    process.env.AXIOM_EXTRA_DATASTREAMS = EXTRA;
    const { logger, PROVISIONED_AXIOM_DATASTREAMS } = await realWiredLogger();

    // Precondition, so this cannot pass by the name being in the snapshot all along.
    expect(PROVISIONED_AXIOM_DATASTREAMS.has(EXTRA)).toBe(false);

    await logger.logToAxiom({ name: 'seam-probe' }, EXTRA);

    // Dies when `buildProvisionedDatastreams()` is called without the parsed extras.
    expect(h.ingestEvents).toHaveBeenCalledTimes(1);
    expect(h.ingestEvents).toHaveBeenCalledWith(EXTRA, expect.anything());
  });

  it('END TO END: a name in neither the snapshot nor the extras is still skipped', async () => {
    process.env.AXIOM_EXTRA_DATASTREAMS = EXTRA;
    const { logger } = await realWiredLogger();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await logger.logToAxiom({ name: 'seam-probe' }, ABSENT);

    // The negative control for the four cases above: they would all pass against a guard that was
    // removed entirely, so one arm has to stay closed.
    expect(h.ingestEvents).not.toHaveBeenCalled();
    const names = errorSpy.mock.calls
      .map(([line]) => {
        try {
          return (JSON.parse(line as string) as { name?: unknown }).name;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    expect(names).toContain('axiom-datastream-unprovisioned');
  });
});
