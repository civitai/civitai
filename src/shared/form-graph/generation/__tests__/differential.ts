import { expect } from 'vitest';
import { generationGraph } from '~/shared/data-graph/generation/generation-graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * The differential harness for the form-graph port.
 *
 * The live `generationGraph.safeParse` is the ORACLE: it is the behaviour
 * production ships today, so when a ported graph disagrees, the port is wrong.
 * Every family gets a case list run through both implementations and compared
 * on three axes — success/failure agreement, per-key value equality, and the
 * full key SET — with any accepted difference declared per case and given a
 * written reason. A delta you cannot explain is a stop-and-ask, not an
 * allowlist entry.
 *
 * Nothing here touches the old graphs; the oracle stays untouched until the
 * old system is deleted, at which point these tests die with it.
 */

export type AnyRecord = Record<string, unknown>;

/** What a ported graph must expose for the harness — form-graph's `parse`. */
export interface PortedGraph {
  parse(
    raw: AnyRecord,
    ext: never
  ):
    | { success: true; data: unknown; state: unknown; notes?: unknown }
    | { success: false; errors: Record<string, unknown>; notes?: unknown };
}

export interface DifferentialCase {
  name: string;
  input: AnyRecord;
  /** Per-case ext override; defaults to the suite's ext. */
  ext?: GenerationCtx;
  /**
   * Keys the PORT produces that the oracle does not. Each entry must carry a
   * reason in the string itself, e.g. `'wanVersion (tag stamped by branch)'`.
   */
  added?: string[];
  /** Keys the ORACLE produces that the port does not — each with a reason. */
  missing?: string[];
  /** Keys present in both whose VALUES differ — each with a reason. */
  valueDeltas?: string[];
}

const bare = (entry: string) => entry.split(/[\s(]/)[0]!;

export function runOracle(input: AnyRecord, ext: GenerationCtx) {
  const result = generationGraph.safeParse(input, ext);
  return result.success
    ? { success: true as const, data: result.data as AnyRecord }
    : { success: false as const, data: {} as AnyRecord, errors: result.errors };
}

export function runPort(graph: PortedGraph, input: AnyRecord, ext: GenerationCtx) {
  const result = graph.parse(input, ext);
  return result.success
    ? {
        success: true as const,
        data: result.data as AnyRecord,
        state: (result as { state?: AnyRecord }).state,
      }
    : { success: false as const, data: {} as AnyRecord, errors: result.errors };
}

/**
 * Compares one case and asserts. Split out so a family suite is a case table
 * plus a `it.each` — the case list is the real work, the comparison is fixed.
 */
export function assertDifferential(
  graph: PortedGraph,
  testCase: DifferentialCase,
  defaultExt: GenerationCtx
) {
  const ext = testCase.ext ?? defaultExt;
  const oracle = runOracle(testCase.input, ext);
  const port = runPort(graph, testCase.input, ext);
  const label = testCase.name;

  expect(port.success, `${label}: success/failure disagreement`).toBe(oracle.success);

  const added = new Set((testCase.added ?? []).map(bare));
  const missing = new Set((testCase.missing ?? []).map(bare));
  const valueDeltas = new Set((testCase.valueDeltas ?? []).map(bare));

  // Both failed: the oracle's error KEYS are the contract (messages are free to
  // differ — form-graph carries its own zod messages). Key-delta declarations
  // describe DATA, which a failed case has none of, so a case that declares
  // them here is carrying a claim nothing can check — refuse it rather than
  // let a stale allowlist entry hide behind a failing case.
  if (!oracle.success && !port.success) {
    expect(
      [...added, ...missing, ...valueDeltas],
      `${label}: declares key deltas but both sides FAILED — move the declaration or fix the case`
    ).toEqual([]);
    expect(Object.keys(port.errors).sort(), `${label}: error keys`).toEqual(
      Object.keys(oracle.errors).sort()
    );
    return;
  }

  // The parse boundary must be a FIXPOINT of resolved state: whatIf feeds the
  // store's state back through parse to price it, so a transform that isn't
  // idempotent would quote a cost for different parameters than submit sends.
  if (port.success && port.state) {
    const again = runPort(graph, port.state, ext);
    expect(again.success, `${label}: state failed to re-parse (whatIf round-trip)`).toBe(true);
    expect(again.data, `${label}: parse is not a fixpoint of its own state`).toEqual(port.data);
  }

  const oracleKeys = Object.keys(oracle.data).sort();
  const portKeys = Object.keys(port.data).sort();

  const unexpectedlyAdded = portKeys.filter((k) => !oracleKeys.includes(k) && !added.has(k));
  const unexpectedlyMissing = oracleKeys.filter((k) => !portKeys.includes(k) && !missing.has(k));

  expect(unexpectedlyAdded, `${label}: port added undeclared keys`).toEqual([]);
  expect(unexpectedlyMissing, `${label}: port dropped keys the oracle produced`).toEqual([]);

  // Declared deltas must still be REAL — a stale allowlist entry is a lie that
  // outlives its reason, so assert each one actually differs.
  for (const key of added) {
    expect(portKeys, `${label}: declared added key "${key}" is not in the port`).toContain(key);
  }
  for (const key of missing) {
    expect(oracleKeys, `${label}: declared missing key "${key}" is not in the oracle`).toContain(
      key
    );
  }

  for (const key of oracleKeys) {
    if (!portKeys.includes(key)) continue;
    if (valueDeltas.has(key)) {
      expect(
        port.data[key],
        `${label}.${key}: declared a value delta but the values match`
      ).not.toEqual(oracle.data[key]);
      continue;
    }
    expect(port.data[key], `${label}.${key}`).toEqual(oracle.data[key]);
  }
}
