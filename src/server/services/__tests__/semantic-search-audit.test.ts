import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { CaptureConfig } from '~/server/clickhouse/sampled-row-buffer';
import type { QueryRefusal } from '~/server/services/semantic-query-guard';
import { GUARD_UNKNOWN } from '~/server/services/semantic-search-client';
import {
  buildSemanticAuditRow,
  createSemanticSearchAudit,
  type SemanticAuditEntry,
  type SemanticAuditRow,
} from '~/server/services/semantic-search-audit.service';

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const SERVED = Array.from({ length: 30 }, (_, i) => i + 1);

const entry = (over: Partial<SemanticAuditEntry> = {}): SemanticAuditEntry => ({
  index: 'images',
  viewer: { id: 7, isModerator: false },
  query: 'fox',
  browsingLevel: 1,
  wordVerdict: false,
  withholdIds: false,
  withholdComputedIds: false,
  resultsServed: true,
  guard: { outcome: 'pass', rules: [], mode: 'shadow', version: 'v1' },
  cacheHit: false,
  resultIds: SERVED,
  ...over,
});
const PASS = { outcome: 'pass' as const, rules: [], mode: 'shadow', version: 'v1' };
const flag = (rules: string[]) => ({
  outcome: 'flag' as const,
  rules,
  mode: 'shadow',
  version: 'v1',
});
const row = (e: SemanticAuditEntry, withheld: string[] | null = null) =>
  buildSemanticAuditRow(e, T0, 'trace-1', withheld && new Set(withheld));

describe('buildSemanticAuditRow', () => {
  it('records the first 20 served ids of a search that passed', () => {
    expect(row(entry()).resultIds).toEqual(SERVED.slice(0, 20));
  });

  it.each([
    'minor',
    'minor-safe',
    'poi-minor',
    'poi',
    'blocked',
    'error',
    // A verdict added after this list was written must withhold too.
    'not-yet-a-verdict' as QueryRefusal,
  ] as const)('stores no ids for a %s verdict, even when results were served', (wordVerdict) => {
    const r = row(entry({ wordVerdict }));
    expect(r.resultIds).toEqual([]);
    expect(r.wordVerdict).toBe(wordVerdict);
    expect(r.query).toBe('fox');
  });

  it('stores no ids when an earlier verdict of the same search withheld them', () => {
    expect(row(entry({ wordVerdict: 'blocked', withholdIds: true })).resultIds).toEqual([]);
  });

  it("stores no ids for a rule on the guard's withheld list, and keeps the rule", () => {
    const r = row(entry({ guard: flag(['nsfw:rule_a']) }), ['nsfw:rule_a']);
    expect(r.resultIds).toEqual([]);
    expect(r.guardRules).toEqual(['nsfw:rule_a']);
  });

  it('keeps the ids for a rule the guard does not withhold', () => {
    expect(row(entry({ guard: flag(['block:rule_b']) }), ['nsfw:rule_a']).resultIds).toHaveLength(
      20
    );
  });

  it('stores no ids for any rule when the withheld list is unknown', () => {
    expect(row(entry({ guard: flag(['block:rule_b']) }), null).resultIds).toEqual([]);
  });

  it.each([
    ['flag', flag([])],
    ['unknown', GUARD_UNKNOWN],
  ])('stores no ids for a %s guard that names no rule', (_, guard) => {
    expect(row(entry({ guard }), []).resultIds).toEqual([]);
  });

  it('keeps the ids for a passing guard that names no rule', () => {
    expect(row(entry({ guard: PASS }), []).resultIds).toEqual(SERVED.slice(0, 20));
  });

  describe('a refused search, run for review and never served', () => {
    const computed = (over: Partial<SemanticAuditEntry> = {}) =>
      entry({ resultsServed: false, withholdIds: true, ...over });

    it.each(['blocked', 'poi'] as const)('stores the ids for a %s refusal', (wordVerdict) => {
      const r = row(computed({ wordVerdict }));
      expect(r.resultIds).toEqual(SERVED.slice(0, 20));
      expect(r.resultsServed).toBe(false);
    });

    it.each([
      'minor',
      'minor-safe',
      'poi-minor',
      'error',
      'not-yet-a-verdict' as QueryRefusal,
    ] as const)('stores no ids for a %s refusal', (wordVerdict) => {
      expect(row(computed({ wordVerdict })).resultIds).toEqual([]);
    });

    it('stores no ids when another verdict of the same search is never run', () => {
      expect(
        row(computed({ wordVerdict: 'blocked', withholdComputedIds: true })).resultIds
      ).toEqual([]);
    });

    it("stores no ids for a rule on the guard's withheld list", () => {
      const r = row(computed({ wordVerdict: 'blocked', guard: flag(['c:rule_a']) }), ['c:rule_a']);
      expect(r.resultIds).toEqual([]);
    });

    it('stores no ids when the guard result is missing or unknown', () => {
      expect(row(computed({ wordVerdict: 'blocked', guard: GUARD_UNKNOWN })).resultIds).toEqual([]);
    });

    it('stores the ids past a known guard with no rule hit', () => {
      expect(row(computed({ wordVerdict: 'blocked' })).resultIds).toEqual(SERVED.slice(0, 20));
    });

    it('sends no resultsServed key on a served row, so it works before the column exists', () => {
      expect(row(entry())).not.toHaveProperty('resultsServed');
    });
  });

  it('names the viewer class from the session', () => {
    expect(row(entry({ viewer: undefined })).viewerClass).toBe('anon');
    expect(row(entry({ viewer: { id: 7, isModerator: true } })).viewerClass).toBe('mod');
    expect(row(entry()).viewerClass).toBe('user');
    expect(row(entry({ viewer: undefined })).userId).toBe(0);
  });
});

describe('createSemanticSearchAudit', () => {
  const ON: CaptureConfig = { sampleRate: 1, until: Number.POSITIVE_INFINITY };
  function harness(
    config: CaptureConfig & { refusalCandidates?: boolean },
    withheld: string[] | null = ['nsfw:rule_a'],
    random = 0.5
  ) {
    const batches: SemanticAuditRow[][] = [];
    const withheldRules = vi.fn(async () => withheld && new Set(withheld));
    const audit = createSemanticSearchAudit({
      getConfig: async () => ({ refusalCandidates: true, ...config }),
      insert: async (rows) => {
        batches.push(rows);
      },
      withheldRules,
      now: () => T0,
      random: () => random,
      flushIntervalMs: 60_000,
    });
    return { audit, batches, withheldRules };
  }

  it('writes nothing while the switch is off', async () => {
    const { audit, batches } = harness({ sampleRate: 0, until: Number.POSITIVE_INFINITY });
    await audit.record(entry());
    await audit.flush();
    expect(batches).toEqual([]);
  });

  it("applies the guard's withheld list to a flagged search", async () => {
    const { audit, batches } = harness(ON);
    await audit.record(entry({ guard: flag(['nsfw:rule_a']) }));
    await audit.record(entry({ guard: flag(['block:rule_b']) }));
    await audit.flush();
    expect(batches[0].map((r) => r.resultIds.length)).toEqual([0, 20]);
  });

  it('keeps every refusal and guard flag at a low rate, and samples the rest', async () => {
    const { audit, batches } = harness({ ...ON, sampleRate: 0.1 }, ['nsfw:rule_a'], 0.9);
    await audit.record(entry());
    await audit.record(entry({ wordVerdict: 'blocked', withholdIds: true }));
    await audit.record(entry({ guard: flag(['block:rule_b']) }));
    await audit.flush();
    expect(batches[0].map((r) => [r.wordVerdict, r.guardRules])).toEqual([
      ['blocked', []],
      [null, ['block:rule_b']],
    ]);
  });

  describe('recordRefused', () => {
    const refused = (over: Partial<SemanticAuditEntry> = {}) =>
      entry({ wordVerdict: 'blocked', withholdIds: true, resultIds: [], ...over });
    const compute = () =>
      vi.fn(async () => ({ ids: [5, 6], guard: flag(['block:rule_b']), cacheHit: true }));

    it('runs a blocked refusal and records what it would have served', async () => {
      const { audit, batches } = harness(ON, []);
      const run = compute();
      await audit.recordRefused(refused(), run);
      await audit.flush();
      expect(run).toHaveBeenCalledTimes(1);
      expect(batches[0][0]).toMatchObject({
        resultIds: [5, 6],
        resultsServed: false,
        guardRules: ['block:rule_b'],
        cacheHit: true,
      });
    });

    it.each([
      ['a minor verdict', refused({ wordVerdict: 'minor' }), ON, 1],
      ['a search with another verdict never run', refused({ withholdComputedIds: true }), ON, 1],
      ['refusalCandidates off', refused(), { ...ON, refusalCandidates: false }, 1],
      ['capture off', refused(), { ...ON, sampleRate: 0 }, 0],
      ['capture past until', refused(), { ...ON, until: T0 - 1 }, 0],
    ])('never runs the search for %s', async (_, e, config, rowsWritten) => {
      const { audit, batches } = harness(config);
      const run = compute();
      await audit.recordRefused(e, run);
      await audit.flush();
      expect(run).not.toHaveBeenCalled();
      expect(batches.flat()).toHaveLength(rowsWritten);
      expect(batches.flat().every((r) => r.resultIds.length === 0 && !('resultsServed' in r))).toBe(
        true
      );
    });

    it('stops running refused searches at the per-minute cap, and resumes the next minute', async () => {
      let at = T0;
      const batches: SemanticAuditRow[][] = [];
      const audit = createSemanticSearchAudit({
        getConfig: async () => ({ ...ON, refusalCandidates: true }),
        insert: async (rows) => {
          batches.push(rows);
        },
        withheldRules: async () => new Set<string>(),
        now: () => at,
        flushIntervalMs: 60_000,
        refusedRunsPerMinute: 2,
      });
      const run = vi.fn(async () => ({ ids: [5, 6], guard: PASS }));
      for (let i = 0; i < 4; i++) await audit.recordRefused(refused(), run);
      expect(run).toHaveBeenCalledTimes(2);
      at += 60_000;
      await audit.recordRefused(refused(), run);
      expect(run).toHaveBeenCalledTimes(3);
      await audit.flush();
      // Capped refusals are still recorded, without ids.
      expect(batches.flat().map((r) => r.resultIds.length)).toEqual([2, 2, 0, 0, 2]);
    });

    it('records the refusal alone when the run fails', async () => {
      const { audit, batches } = harness(ON);
      await audit.recordRefused(refused(), async () => {
        throw new Error('search down');
      });
      await audit.flush();
      expect(batches[0][0]).toMatchObject({ wordVerdict: 'blocked', resultIds: [] });
      expect(batches[0][0]).not.toHaveProperty('resultsServed');
    });
  });

  it('stores no ids for a flagged search when the withheld list cannot be read', async () => {
    const { audit, batches, withheldRules } = harness(ON);
    withheldRules.mockRejectedValueOnce(new Error('status down'));
    await audit.record(entry({ guard: flag(['block:rule_b']) }));
    await audit.flush();
    expect(batches[0][0].resultIds).toEqual([]);
  });
});

// TypeScript cannot check a row type against a ClickHouse DDL, and a drift 400s the whole batch
// into a swallowed catch, so the two are pinned to each other here.
describe('semanticSearchAudit row ↔ DDL parity', () => {
  const migration = (name: string) =>
    readFileSync(path.resolve(__dirname, '../../clickhouse/migrations', name), 'utf8');

  it('writes exactly the columns the table declares', () => {
    const sql = migration('2026-11-14-semantic-search-audit.sql');
    const open = 'semanticSearchAudit\n(';
    const columns = sql
      .slice(sql.indexOf(open) + open.length, sql.indexOf('\n)\nENGINE'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0]);
    const added = [
      ...migration('2026-11-15-semantic-search-audit-results-served.sql').matchAll(
        /ADD COLUMN IF NOT EXISTS `(\w+)`/g
      ),
    ].map((m) => m[1]);
    expect(columns.length).toBeGreaterThan(10);
    expect(added).toEqual(['resultsServed']);
    // A served row writes the original columns only; a computed row adds the later one.
    expect(new Set(Object.keys(row(entry())))).toEqual(new Set(columns));
    const computedRow = row(entry({ resultsServed: false, wordVerdict: 'blocked' }));
    expect(new Set(Object.keys(computedRow))).toEqual(new Set([...columns, ...added]));
  });
});
