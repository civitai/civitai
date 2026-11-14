import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { CaptureConfig } from '~/server/clickhouse/sampled-row-buffer';
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
  guard: { outcome: 'pass', rules: [], mode: 'shadow', version: 'v1' },
  cacheHit: false,
  resultIds: SERVED,
  ...over,
});
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

  it.each(['minor', 'poi-minor', 'error'] as const)(
    'stores no ids for a %s verdict, even when results were served',
    (wordVerdict) => {
      const r = row(entry({ wordVerdict }));
      expect(r.resultIds).toEqual([]);
      expect(r.wordVerdict).toBe(wordVerdict);
      expect(r.query).toBe('fox');
    }
  );

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

  it('names the viewer class from the session', () => {
    expect(row(entry({ viewer: undefined })).viewerClass).toBe('anon');
    expect(row(entry({ viewer: { id: 7, isModerator: true } })).viewerClass).toBe('mod');
    expect(row(entry()).viewerClass).toBe('user');
    expect(row(entry({ viewer: undefined })).userId).toBe(0);
  });
});

describe('createSemanticSearchAudit', () => {
  const ON: CaptureConfig = { sampleRate: 1, until: Number.POSITIVE_INFINITY };
  function harness(config: CaptureConfig, withheld: string[] | null = ['nsfw:rule_a']) {
    const batches: SemanticAuditRow[][] = [];
    const withheldRules = vi.fn(async () => withheld && new Set(withheld));
    const audit = createSemanticSearchAudit({
      getConfig: async () => config,
      insert: async (rows) => {
        batches.push(rows);
      },
      withheldRules,
      now: () => T0,
      random: () => 0.5,
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
  it('writes exactly the columns the table declares', () => {
    const sql = readFileSync(
      path.resolve(__dirname, '../../clickhouse/migrations/2026-11-14-semantic-search-audit.sql'),
      'utf8'
    );
    const open = 'semanticSearchAudit\n(';
    const columns = sql
      .slice(sql.indexOf(open) + open.length, sql.indexOf('\n)\nENGINE'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0]);
    expect(columns.length).toBeGreaterThan(10);
    expect(new Set(Object.keys(row(entry())))).toEqual(new Set(columns));
  });
});
