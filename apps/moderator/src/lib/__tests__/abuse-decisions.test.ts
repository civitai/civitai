import { describe, expect, it } from 'vitest';
import { groupFindings, storedVerdict, type GroupableFinding } from '../abuse-decisions';
import { ABUSE_VERDICTS } from '../abuse-verdicts';

/**
 * The collapse rule the run page renders.
 *
 * 🔴 WHY THESE ARE HERE AND NOT IN A ROUTE TEST. This app has no component render harness, so a
 * grouping written inside a `$derived` would be untestable — and the two failure modes are both
 * invisible to a type checker AND to a source-level grep: a ring of eleven rendering as one row that
 * rules one account, and eleven ungrouped findings collapsing into a single row that rules them all.
 * Both render plausibly, with a count and a member list, so the bug reads as the feature working.
 *
 * Fixtures use PAIRWISE-DISTINCT confidences and ids so no assertion can pass by two values
 * coinciding.
 */

const f = (over: Partial<GroupableFinding> & { id: number }): GroupableFinding => ({
  actioned: false,
  confidence: 0.5,
  groupKey: null,
  verdict: null,
  ...over,
});

describe('groupFindings', () => {
  it('collapses a cluster into ONE decision carrying every member', () => {
    const rows = [
      f({ id: 1, groupKey: 'domain:ring.test', confidence: 0.91 }),
      f({ id: 2, groupKey: 'domain:ring.test', confidence: 0.62 }),
      f({ id: 3, groupKey: 'domain:ring.test', confidence: 0.44 }),
    ];
    const out = groupFindings(rows);
    expect(out).toHaveLength(1);
    expect(out[0].members.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(out[0].groupKey).toBe('domain:ring.test');
    expect(out[0].id).toBe('group:domain:ring.test');
  });

  it('🔴 does NOT collapse ungrouped findings into one another', () => {
    // A NULL key is the ABSENCE of a group. Bucketing on the raw value gives one row claiming to
    // cover four unrelated accounts — and it renders perfectly.
    const rows = [f({ id: 1 }), f({ id: 2 }), f({ id: 3 }), f({ id: 4 })];
    const out = groupFindings(rows);
    expect(out).toHaveLength(4);
    expect(out.every((d) => d.members.length === 1)).toBe(true);
    expect(out.map((d) => d.id).sort()).toEqual([
      'finding:1',
      'finding:2',
      'finding:3',
      'finding:4',
    ]);
  });

  it('keeps two different clusters apart', () => {
    const rows = [
      f({ id: 1, groupKey: 'domain:a.test', confidence: 0.9 }),
      f({ id: 2, groupKey: 'domain:b.test', confidence: 0.8 }),
      f({ id: 3, groupKey: 'domain:a.test', confidence: 0.7 }),
    ];
    const out = groupFindings(rows);
    expect(out.map((d) => d.groupKey)).toEqual(['domain:a.test', 'domain:b.test']);
    expect(out[0].members.map((m) => m.id)).toEqual([1, 3]);
    expect(out[1].members.map((m) => m.id)).toEqual([2]);
  });

  it('🔴 a producer key that looks like a row key cannot collide with one', () => {
    // The namespaces exist for this. A producer's key is an opaque string IT chose; `"7"` is a legal
    // one, and bucketing an ungrouped finding on its bare id would merge finding 7 into it.
    const rows = [f({ id: 7 }), f({ id: 8, groupKey: '7' })];
    const out = groupFindings(rows);
    expect(out).toHaveLength(2);
    expect(out.map((d) => d.id).sort()).toEqual(['finding:7', 'group:7']);
  });

  it('mixes grouped and ungrouped findings in one run', () => {
    const rows = [
      f({ id: 1, groupKey: 'domain:ring.test', confidence: 0.9 }),
      f({ id: 2, confidence: 0.8 }),
      f({ id: 3, groupKey: 'domain:ring.test', confidence: 0.7 }),
      f({ id: 4, confidence: 0.6 }),
    ];
    const out = groupFindings(rows);
    expect(out.map((d) => d.members.length)).toEqual([2, 1, 1]);
  });

  it('leads with the acted-on row, then the most confident', () => {
    // The page's existing order. The lead is the row whose reason a moderator actually reads, so
    // picking it by input order would change what they see when the service's sort changed.
    const rows = [
      f({ id: 1, confidence: 0.3 }),
      f({ id: 2, confidence: 0.95 }),
      f({ id: 3, confidence: 0.4, actioned: true }),
    ];
    expect(groupFindings(rows).map((d) => d.lead.id)).toEqual([3, 2, 1]);
  });

  it('picks the cluster lead the same way, inside the cluster', () => {
    const rows = [
      f({ id: 1, groupKey: 'k', confidence: 0.2 }),
      f({ id: 2, groupKey: 'k', confidence: 0.99 }),
      f({ id: 3, groupKey: 'k', confidence: 0.4, actioned: true }),
    ];
    const out = groupFindings(rows);
    expect(out[0].lead.id).toBe(3);
    expect(out[0].members.map((m) => m.id)).toEqual([3, 2, 1]);
  });

  it('does not mutate the array it was given', () => {
    const rows = [f({ id: 1, confidence: 0.1 }), f({ id: 2, confidence: 0.9 })];
    groupFindings(rows);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('returns nothing for a run with no findings', () => {
    expect(groupFindings([])).toEqual([]);
  });
});

describe('storedVerdict', () => {
  it('reports the shared verdict of a cluster', () => {
    const [d] = groupFindings([
      f({ id: 1, groupKey: 'k', verdict: 'tp' }),
      f({ id: 2, groupKey: 'k', verdict: 'tp' }),
    ]);
    expect(storedVerdict(d)).toBe('tp');
  });

  it('reports null when nobody has ruled', () => {
    const [d] = groupFindings([f({ id: 1, groupKey: 'k' }), f({ id: 2, groupKey: 'k' })]);
    expect(storedVerdict(d)).toBeNull();
  });

  it('🔴 reports `mixed` rather than presenting one member’s ruling as the cluster’s', () => {
    const [d] = groupFindings([
      f({ id: 1, groupKey: 'k', verdict: 'tp' }),
      f({ id: 2, groupKey: 'k', verdict: 'fp' }),
    ]);
    expect(storedVerdict(d)).toBe('mixed');
  });

  it('a half-ruled cluster is mixed too — an unruled member is a disagreement', () => {
    const [d] = groupFindings([
      f({ id: 1, groupKey: 'k', verdict: 'tp' }),
      f({ id: 2, groupKey: 'k', verdict: null }),
    ]);
    expect(storedVerdict(d)).toBe('mixed');
  });

  it.each(ABUSE_VERDICTS)('round-trips a lone finding ruled %s', (verdict) => {
    const [d] = groupFindings([f({ id: 1, verdict })]);
    expect(storedVerdict(d)).toBe(verdict);
  });
});
