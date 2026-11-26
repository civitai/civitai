import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  getAgentReport,
  getPriorAgentReport,
  listAgentReports,
} from '../app-review-report.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockFindMany = dbMock.dbRead.appReviewAgentReport.findMany;
const mockFindFirst = dbMock.dbRead.appReviewAgentReport.findFirst;

// Minimal row factory — only the fields the selection logic reads.
const report = (over: { id: string; version: string; startedAt?: Date; status?: string }) => ({
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

  it('queries only status="complete" on-site reports and scopes to the slug key', async () => {
    mockFindMany.mockResolvedValue([]);
    await getPriorAgentReport({ slug: 's_x', version: '2.0.0' });
    expect(mockFindMany).toHaveBeenCalledWith({
      // `kind: 'onsite'` keeps a connect-listing report (placeholder version) out of the chain.
      where: { slug: 's_x', status: 'complete', kind: 'onsite' },
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
      report({
        id: 'arar_newest_started',
        version: '0.2.0',
        startedAt: new Date('2026-03-01T00:00:00Z'),
      }),
      report({
        id: 'arar_highest_semver',
        version: '0.10.0',
        startedAt: new Date('2026-01-01T00:00:00Z'),
      }),
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
    await expect(getPriorAgentReport({ slug: 's_x', version: 'not-a-version' })).rejects.toThrow(
      /invalid semver/
    );
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

  it('🔴 a chosen run (report picker) is looked up WITHIN the request, never by id alone', async () => {
    // The tRPC gate is per request; an id-only lookup would let a report id from another
    // request (another lane, another flag) be read through this request's gate.
    mockFindFirst.mockResolvedValue({ id: 'arar_old' });
    await getAgentReport('pubreq_1', 'arar_old');
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { publishRequestId: 'pubreq_1', id: 'arar_old' },
      orderBy: { startedAt: 'desc' },
    });
  });
});

describe('listAgentReports', () => {
  it('lists every run of the request, newest first, without report content; cost as a number', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'arar_2',
        model: 'openrouter/b/m',
        status: 'running',
        startedAt: new Date('2026-01-02T00:00:00Z'),
        completedAt: null,
        costUsd: null,
      },
      {
        id: 'arar_1',
        model: 'openrouter/a/m',
        status: 'failed',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        completedAt: new Date('2026-01-01T00:05:00Z'),
        // Prisma hands a Decimal; anything with a numeric toString stands in for it.
        costUsd: { toString: () => '0.012500' },
      },
    ]);
    const runs = await listAgentReports('pubreq_1');
    expect(runs.map((r) => [r.id, r.costUsd])).toEqual([
      ['arar_2', null],
      ['arar_1', 0.0125],
    ]);
    const args = mockFindMany.mock.calls[0][0] as {
      where: unknown;
      orderBy: unknown;
      select: Record<string, boolean>;
    };
    expect(args.where).toEqual({ publishRequestId: 'pubreq_1' });
    expect(args.orderBy).toEqual({ startedAt: 'desc' });
    // The picker never needs the analyses themselves.
    expect(Object.keys(args.select).sort()).toEqual(
      ['completedAt', 'costUsd', 'id', 'model', 'startedAt', 'status'].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Connect lane: the "Checked by Civitai" view comes from its own table, never the runner's output.
// ---------------------------------------------------------------------------
describe('getAgentReport — connect lane checks view', () => {
  const ALPR = 'alpr_0123456789ABCDEFGHJKMNPQRS';
  const CHECKS = {
    offlineAccess: { reachable: true, alwaysOffline: false, grants: ['refresh_token'] },
    source: { provided: false },
  };
  const subject = {
    publishRequestId: ALPR,
    slug: 'photo-sync',
    changelog: null,
    listing: {
      id: 'apl_L',
      name: 'Photo Sync',
      tagline: null,
      description: 'Copies your images nightly.',
      category: null,
      externalUrl: null,
      sourceRepoUrl: null,
      contentRating: null,
      requestedScopes: 32,
      scopeJustifications: { MediaRead: 'copy images' },
    },
    client: {
      id: 'oc_C',
      name: 'c',
      description: '',
      redirectUris: ['https://p.example/cb'],
      allowedOrigins: [],
      grants: ['refresh_token'],
      isConfidential: true,
      isVerified: false,
    },
  };
  const liveRequest = (description: string) => ({
    id: ALPR,
    kind: 'offsite',
    slug: 'photo-sync',
    status: 'pending',
    changelog: null,
    appListing: {
      id: 'apl_L',
      kind: 'offsite',
      name: 'Photo Sync',
      tagline: null,
      description,
      category: null,
      externalUrl: null,
      contentRating: null,
      connectRequestedScopes: 32,
      connectScopeJustifications: { MediaRead: 'copy images' },
      connectClient: {
        id: 'oc_C',
        name: 'c',
        description: '',
        redirectUris: ['https://p.example/cb'],
        allowedOrigins: [],
        grants: ['refresh_token'],
        isConfidential: true,
        isVerified: false,
      },
    },
  });
  // Runner output that IMITATES Civitai's facts: a near-identical scope key, a look-alike title,
  // and the "origin" the earlier design trusted.
  const imitatingReport = {
    id: 'arar_C',
    publishRequestId: ALPR,
    status: 'complete',
    scopeVerdicts: {
      scopes: [{ declared: 'offline_access ', sensitive: false, origin: 'civitai' }],
    },
    securityAudit: { findings: [{ title: 'Checked by Civitai: no issues', origin: 'civitai' }] },
    codeReview: { findings: [{ title: 'Offline access: not reachable', origin: 'civitai' }] },
    summaryMd: 'Checked by Civitai, not by the review agent: Offline access: not reachable.',
  };

  let fingerprintOfReviewed: string;
  beforeEach(async () => {
    const { connectListingFingerprint } = await import('../connect-agent-review.logic');
    fingerprintOfReviewed = connectListingFingerprint(subject);
    mockFindFirst.mockResolvedValue(imitatingReport as never);
    dbMock.dbRead.appReviewAgentReportCheck.findUnique.mockResolvedValue({
      checks: CHECKS,
      fingerprint: fingerprintOfReviewed,
    } as never);
    dbMock.dbRead.appListingPublishRequest.findUnique.mockResolvedValue(
      liveRequest('Copies your images nightly.') as never
    );
    dbMock.dbRead.appListing.findUnique.mockResolvedValue({ sourceRepoUrl: null } as never);
  });

  it('🔴 D2: the block is the stored checks alone; no imitation in the runner output reaches it', async () => {
    const { civitaiCheckLines } = await import('~/shared/constants/connect-agent-review.constants');
    const r = await getAgentReport(ALPR);
    expect(dbMock.dbRead.appReviewAgentReportCheck.findUnique).toHaveBeenCalledWith({
      where: { reportId: 'arar_C' },
      select: { checks: true, fingerprint: true },
    });
    expect(r?.civitaiChecks).toEqual({ checks: CHECKS, stale: false });
    const blockText = civitaiCheckLines(r!.civitaiChecks!.checks)
      .map((l) => l.text)
      .join('\n');
    expect(blockText).toBe(
      'Offline access: REACHABLE. The app can ask for offline_access; once a user approves it, ' +
        'the app holds a refreshable token and can act while the user is away, until they disconnect.\n' +
        'No server source was provided with this submission, so the source review and the token ' +
        'storage and exfiltration checks did not run. An empty code review is not a clean result.'
    );
    for (const imitation of ['offline_access ', 'Offline access: not reachable', 'no issues'])
      expect(blockText).not.toContain(imitation);
  });

  it('🔴 F3: the listing edited after the review → stale', async () => {
    dbMock.dbRead.appListingPublishRequest.findUnique.mockResolvedValue(
      liveRequest('Copies your images nightly, and posts on your behalf.') as never
    );
    const r = await getAgentReport(ALPR);
    expect(r?.civitaiChecks?.stale).toBe(true);
  });

  it('F3: a listing that can no longer be read counts as changed', async () => {
    dbMock.dbRead.appListingPublishRequest.findUnique.mockResolvedValue(null as never);
    const r = await getAgentReport(ALPR);
    expect(r?.civitaiChecks?.stale).toBe(true);
  });

  it('no checks row (or no table yet) → civitaiChecks null, the report still returned', async () => {
    dbMock.dbRead.appReviewAgentReportCheck.findUnique.mockRejectedValue(new Error('no table'));
    const r = await getAgentReport(ALPR);
    expect(r?.id).toBe('arar_C');
    expect(r?.civitaiChecks).toBeNull();
  });

  it('on-site reports are returned as before, with no checks lookup', async () => {
    mockFindFirst.mockResolvedValue({ id: 'arar_O', publishRequestId: 'pubreq_X' } as never);
    const r = await getAgentReport('pubreq_X');
    expect(r).toEqual({ id: 'arar_O', publishRequestId: 'pubreq_X' });
    expect(dbMock.dbRead.appReviewAgentReportCheck.findUnique).not.toHaveBeenCalled();
  });
});
