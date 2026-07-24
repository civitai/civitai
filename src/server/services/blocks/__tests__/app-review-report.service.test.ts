import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * App Blocks agentic mod code-review report — P0 lookup layer (DARK).
 *
 * Covers the prior-report selection: picks the latest COMPLETE report strictly
 * semver-older than the version under review (semver, not lexical, ordering),
 * queries only status='complete' (so running/failed/torn-down/cost-capped are
 * excluded at the DB), scopes to the stable `slug` key, returns null when there
 * is no earlier report, and enforces the non-empty-slug + valid semver
 * invariants. Plus getAgentReport's by-review lookup.
 */

const { mockFindMany, mockFindFirst } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockFindFirst: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    appReviewAgentReport: { findMany: mockFindMany, findFirst: mockFindFirst },
  },
}));

import {
  getAgentReport,
  getPriorAgentReport,
} from '../app-review-report.service';

// Minimal row factory — only the fields the selection logic reads.
const report = (over: {
  id: string;
  version: string;
  startedAt?: Date;
  status?: string;
}) => ({
  id: over.id,
  version: over.version,
  status: over.status ?? 'complete',
  startedAt: over.startedAt ?? new Date('2026-01-01T00:00:00Z'),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getPriorAgentReport', () => {
  it('picks the latest complete report strictly older than the target (semver, not lexical)', async () => {
    // Lexical order would wrongly pick 0.9.0 over 0.10.0 — semver must pick 0.10.0.
    mockFindMany.mockResolvedValue([
      report({ id: 'arar_a', version: '0.1.0' }),
      report({ id: 'arar_b', version: '0.9.0' }),
      report({ id: 'arar_c', version: '0.10.0' }),
    ]);

    const prior = await getPriorAgentReport({ slug: 's_x', version: '1.0.0' });
    expect(prior?.id).toBe('arar_c');
  });

  it('queries only status="complete" and scopes to the slug key', async () => {
    mockFindMany.mockResolvedValue([]);
    await getPriorAgentReport({ slug: 's_x', version: '2.0.0' });
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { slug: 's_x', status: 'complete' },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
  });

  it('excludes the same version and any newer version', async () => {
    mockFindMany.mockResolvedValue([
      report({ id: 'arar_eq', version: '1.0.0' }), // equal -> excluded
      report({ id: 'arar_new', version: '1.1.0' }), // newer -> excluded
      report({ id: 'arar_old', version: '0.5.0' }), // older -> the answer
    ]);
    const prior = await getPriorAgentReport({ slug: 's_x', version: '1.0.0' });
    expect(prior?.id).toBe('arar_old');
  });

  it('returns null when the app has no earlier complete report', async () => {
    mockFindMany.mockResolvedValue([report({ id: 'arar_only', version: '1.0.0' })]);
    const prior = await getPriorAgentReport({ slug: 's_x', version: '1.0.0' });
    expect(prior).toBeNull();
  });

  it('breaks a same-version tie on startedAt desc', async () => {
    mockFindMany.mockResolvedValue([
      report({ id: 'arar_early', version: '0.9.0', startedAt: new Date('2026-01-01T00:00:00Z') }),
      report({ id: 'arar_late', version: '0.9.0', startedAt: new Date('2026-02-01T00:00:00Z') }),
    ]);
    const prior = await getPriorAgentReport({ slug: 's_x', version: '1.0.0' });
    expect(prior?.id).toBe('arar_late');
  });

  it('picks the semver-latest even when the recency-bounded fetch returns a different order', async () => {
    // The query is bounded/ordered by startedAt desc; the in-app semver sort is
    // authoritative, so the greatest older version wins regardless of fetch order.
    mockFindMany.mockResolvedValue([
      report({ id: 'arar_newest_started', version: '0.2.0', startedAt: new Date('2026-03-01T00:00:00Z') }),
      report({ id: 'arar_highest_semver', version: '0.10.0', startedAt: new Date('2026-01-01T00:00:00Z') }),
      report({ id: 'arar_mid', version: '0.9.0', startedAt: new Date('2026-02-01T00:00:00Z') }),
    ]);
    const prior = await getPriorAgentReport({ slug: 's_x', version: '1.0.0' });
    expect(prior?.id).toBe('arar_highest_semver');
  });

  it('throws when the slug is empty', async () => {
    await expect(getPriorAgentReport({ slug: '', version: '1.0.0' })).rejects.toThrow(
      /non-empty slug/
    );
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('throws on an invalid semver version', async () => {
    await expect(
      getPriorAgentReport({ slug: 's_x', version: 'not-a-version' })
    ).rejects.toThrow(/invalid semver/);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});

describe('getAgentReport', () => {
  it('returns the most-recently-started report for a review', async () => {
    mockFindFirst.mockResolvedValue({ id: 'arar_z' });
    const r = await getAgentReport('pubreq_1');
    expect(r).toEqual({ id: 'arar_z' });
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { publishRequestId: 'pubreq_1' },
      orderBy: { startedAt: 'desc' },
    });
  });

  it('returns null for an empty id without querying', async () => {
    const r = await getAgentReport('');
    expect(r).toBeNull();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});
