import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  APP_BLOCK_REVOCATION_NAMESPACES,
  revocationNamespaceLabel,
} from '~/server/metrics/app-block-runtime.metrics';

/**
 * 🔴 THE BRANCH ORDER IN `revocationNamespaceLabel` IS LOAD-BEARING, AND IT SHIPPED WITH
 * NOTHING GUARDING IT.
 *
 * Its own docblock says so — `page_pubreq_` and `page_local_` are prefixed by `page_`, so
 * they must be tested BEFORE it or they collapse into it. A complete enumeration across
 * `src` found no test referencing this function, the emitter, or the series name: swapping
 * the three `startsWith` lines was a silent mutant.
 *
 * That collapse is not hypothetical bookkeeping. This label exists to make "has revocation
 * ever fired on THIS surface" readable per namespace, and the `page_` family is exactly
 * where the coverage gaps have repeatedly been — the writer reaches some of these shapes
 * and not others, and a counter that merged them would report the covered ones' traffic as
 * if it proved the uncovered ones were fine.
 */
describe('revocationNamespaceLabel', () => {
  /**
   * 🔴 THE ORDER GUARD. Each of these is a real minted shape whose id is ALSO a valid
   * `page_` / `bus_` prefix match, so a reordered chain returns the shorter prefix's
   * label instead. Asserting the exact label, not merely "not other".
   */
  it.each([
    ['page_pubreq_pubreq_01JEXAMPLE', 'page_pubreq', 'dev-token pending submission'],
    ['page_local_my-app', 'page_local', 'dev-token local no-server-row app'],
    ['page_apb_01JEXAMPLE', 'page', 'approved block page'],
    ['page_pubreq_01JEXAMPLE', 'page_pubreq', 'mod review preview (single pubreq_)'],
    ['page_ephemeral-my-app', 'page', 'ephemeral tunnel app'],
    ['bus_pub_bus_01JEXAMPLE', 'bus_pub', 'blanket publisher subscription'],
    ['bus_view_bus_01JEXAMPLE', 'bus_view', 'viewer subscription'],
    ['pdb_apb_01JEXAMPLE', 'pdb', 'platform default'],
    ['bki_01JEXAMPLE', 'bki', 'pinned install'],
    ['mbi_01JEXAMPLE', 'mbi', 'legacy pinned install'],
  ])('%s → %s (%s)', (instanceId, expected) => {
    expect(
      revocationNamespaceLabel(instanceId),
      `"${instanceId}" was bucketed wrongly — if this is a page_* or bus_* shape, the ` +
        '`startsWith` chain has been reordered and the longer prefix is now unreachable'
    ).toBe(expected);
  });

  /**
   * 🔴 THE ORDER, STATED AS AN ORDER rather than only as its consequences. The cases
   * above would all still pass if someone added a redundant earlier branch that happened
   * to produce the right answer; this reads the chain itself.
   */
  it('tests every prefix BEFORE any prefix it extends', () => {
    const source = readFileSync(path.join(__dirname, '../app-block-runtime.metrics.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function revocationNamespaceLabel'));
    const order = [...body.slice(0, body.indexOf('\n}')).matchAll(/startsWith\('([^']+)'\)/g)].map(
      (m) => m[1]
    );
    expect(
      order.length,
      'no startsWith chain found — this guard is reading nothing'
    ).toBeGreaterThan(3);
    // No earlier entry may be EXTENDED by a later one, or the later one is unreachable.
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        expect(
          order[j].startsWith(order[i]) && order[j] !== order[i],
          `"${order[j]}" extends "${order[i]}" but is tested AFTER it — unreachable`
        ).toBe(false);
      }
    }
  });

  it('buckets an unknown or non-string id to `other` rather than throwing', () => {
    for (const value of ['who_knows', '', 'apb_01JEXAMPLE', undefined, null, 42, {}]) {
      expect(revocationNamespaceLabel(value)).toBe('other');
    }
  });

  it('never returns a label outside the bounded set — the cardinality guarantee', () => {
    const inputs = ['page_x', 'bus_pub_x', 'pdb_x', 'bki_x', 'mbi_x', 'nonsense', ''];
    for (const i of inputs) {
      expect(APP_BLOCK_REVOCATION_NAMESPACES).toContain(revocationNamespaceLabel(i));
    }
  });
});
