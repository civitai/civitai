import { describe, expect, it, vi } from 'vitest';
import type * as AuditService from '~/server/services/semantic-search-audit.service';
import type {
  SemanticAuditEntry,
  SemanticAuditRow,
} from '~/server/services/semantic-search-audit.service';
import { beginSemanticAudit, type QueryRefusal } from '~/server/services/semantic-query-guard';
import { createSemanticSearchAudit } from '~/server/services/semantic-search-audit.service';

const h = vi.hoisted(() => ({ recordRefused: vi.fn() }));

vi.mock('~/server/services/semantic-search-audit.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AuditService>()),
  recordRefusedSemanticAudit: h.recordRefused,
}));

// A search can collect several verdicts (each word audit reports one). A minor-class verdict
// anywhere in the sequence must keep a refused search's candidate ids out of the audit.
async function storedIds(sequence: QueryRefusal[]) {
  h.recordRefused.mockClear();
  const audit = beginSemanticAudit({
    index: 'images',
    viewer: { id: 7, isModerator: false },
    query: 'fox',
    firstPage: true,
  });
  for (const v of sequence) audit.verdict(v);
  const guard = { outcome: 'pass' as const, rules: [], mode: 'shadow', version: 'v1' };
  const compute = vi.fn(async () => ({ ids: [5, 6, 7], guard }));
  audit.refused({ items: [] }, 1, compute);
  const [entry] = h.recordRefused.mock.calls[0] as [SemanticAuditEntry];

  const batches: SemanticAuditRow[][] = [];
  const store = createSemanticSearchAudit({
    getConfig: async () => ({
      sampleRate: 1,
      until: Number.POSITIVE_INFINITY,
      refusalCandidates: true,
    }),
    insert: async (rows) => {
      batches.push(rows);
    },
    withheldRules: async () => new Set<string>(),
    flushIntervalMs: 60_000,
  });
  await store.recordRefused(entry, compute);
  await store.flush();
  return batches.flat().flatMap((r) => r.resultIds);
}

describe('a refused search stores candidate ids only when no verdict is minor-class', () => {
  it.each<[string, QueryRefusal[]]>([
    ['blocked then minor', ['blocked', 'minor']],
    ['minor then blocked', ['minor', 'blocked']],
    ['poi then poi-minor', ['poi', 'poi-minor']],
  ])('%s: no ids stored', async (_, sequence) => {
    expect(await storedIds(sequence)).toEqual([]);
  });

  it('blocked alone: ids stored', async () => {
    expect(await storedIds(['blocked'])).toEqual([5, 6, 7]);
  });
});
