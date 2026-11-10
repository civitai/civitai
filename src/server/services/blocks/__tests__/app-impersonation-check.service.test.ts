import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';
import type { ImpersonationSubject } from '~/server/services/blocks/app-impersonation.logic';
import type { ModelCall } from '~/server/services/blocks/app-impersonation-check.service';
import type * as BlocklistService from '~/server/services/blocklist.service';

type ModelArgs = Parameters<ModelCall>[0];

/**
 * The impersonation check end to end: the three checks combined (with the model call
 * injected), and the run against a stored agent report — what it reads and what it writes
 * back. Brand names are invented; the real list is moderator-managed data.
 */

const m = vi.hoisted(() => ({
  terms: ['Zorblex'] as string[],
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  getBlocklistData: vi.fn(async () => m.terms),
}));

const { runImpersonationChecks, runImpersonationCheckForRequest } = await import(
  '~/server/services/blocks/app-impersonation-check.service'
);

const subject = (over: Partial<ImpersonationSubject> = {}): ImpersonationSubject => ({
  name: 'Sketch Helper',
  slug: 'sketch-helper',
  tagline: null,
  description: null,
  ...over,
});
const inputs = (over: Partial<Parameters<typeof runImpersonationChecks>[0]> = {}) => ({
  subject: subject(),
  iconUrl: null,
  coverUrl: null,
  others: [],
  protectedTerms: ['Zorblex'],
  maxNameEdits: 0,
  ...over,
});
const clearModel = vi.fn(async (_args: ModelArgs) => ({
  judgement: { findings: [] as unknown[] },
  costUsd: 0.002 as number | null,
}));
const NOW = new Date('2026-11-10T12:00:00Z');

beforeEach(() => {
  // The canonical db mock resets per FILE; these cases each set their own rows.
  resetHybridNodes();
  m.terms = ['Zorblex'];
  clearModel.mockClear();
});

describe('runImpersonationChecks', () => {
  it('nothing found: a COMPLETE record with every check clear', async () => {
    const r = await runImpersonationChecks(inputs(), clearModel, NOW);
    expect(r.findings).toEqual([]);
    expect(r.record).toEqual({
      status: 'complete',
      ranAt: '2026-11-10T12:00:00.000Z',
      checks: {
        'listing-name-match': 'clear',
        'protected-term': 'clear',
        'model-judgement': 'clear',
      },
      model: expect.any(String),
    });
    expect(r.costUsd).toBe(0.002);
  });

  it('each check records whether IT fired', async () => {
    const model = vi.fn(async (_args: ModelArgs) => ({
      judgement: { findings: [{ severity: 'high', title: 'Icon copies the Zorblex logo' }] },
      costUsd: null,
    }));
    const r = await runImpersonationChecks(
      inputs({
        subject: subject({ name: 'Zorblex Studio', slug: 'zstudio' }),
        others: [{ id: 'apl_o', name: 'Zorblex Studio', slug: 'zorblex-studio', appBlockId: null }],
      }),
      model,
      NOW
    );
    expect(r.record.checks).toEqual({
      'listing-name-match': 'fired',
      'protected-term': 'fired',
      'model-judgement': 'fired',
    });
    expect(r.findings.map((f) => [f.check, f.severity])).toEqual([
      ['listing-name-match', 'medium'],
      ['protected-term', 'medium'],
      ['model-judgement', 'high'],
    ]);
    // The model was told what the deterministic checks matched.
    expect(model.mock.calls[0][0].deterministic).toHaveLength(2);
  });

  it('🔴 a model failure keeps the deterministic findings and FAILS the record', async () => {
    const r = await runImpersonationChecks(
      inputs({ subject: subject({ name: 'Zorblex Helper' }) }),
      async () => {
        throw new Error('provider 500');
      },
      NOW
    );
    expect(r.record.status).toBe('failed');
    expect(r.record.checks['model-judgement']).toBe('failed');
    expect(r.record.error).toContain('provider 500');
    expect(r.findings.map((f) => f.check)).toEqual(['protected-term']);
  });

  it('🔴 an EMPTY protected-term list fails the record instead of passing it', async () => {
    const r = await runImpersonationChecks(inputs({ protectedTerms: [] }), clearModel, NOW);
    expect(r.record.status).toBe('failed');
    expect(r.record.checks['protected-term']).toBe('failed');
    const blank = await runImpersonationChecks(inputs({ protectedTerms: ['  '] }), clearModel, NOW);
    expect(blank.record.status).toBe('failed');
  });

  it('a declaration the model QUOTES from the listing lowers a protected-term hit to low', async () => {
    const s = subject({ name: 'Zorblex Helper', tagline: 'An unofficial fan-made helper' });
    const r = await runImpersonationChecks(
      inputs({ subject: s }),
      async () => ({
        judgement: { findings: [], declaredUnofficialQuote: 'An unofficial fan-made helper' },
        costUsd: null,
      }),
      NOW
    );
    expect(r.findings.map((f) => f.severity)).toEqual(['low']);
    expect(r.record.status).toBe('complete');
  });

  it('🔴 a declaration the listing does NOT contain changes nothing', async () => {
    const r = await runImpersonationChecks(
      inputs({ subject: subject({ name: 'Zorblex Helper' }) }),
      async () => ({
        judgement: { findings: [], declaredUnofficialQuote: 'This app is unofficial' },
        costUsd: null,
      }),
      NOW
    );
    expect(r.findings.map((f) => f.severity)).toEqual(['medium']);
  });
});

describe('runImpersonationCheckForRequest', () => {
  const PUBREQ = 'pubreq_01';
  function seed(report: Record<string, unknown> | null) {
    dbMock.dbRead.appReviewAgentReport.findFirst.mockResolvedValue(report as never);
    dbMock.dbRead.appBlockPublishRequest.findUnique.mockResolvedValue({
      slug: 'zorblex-helper',
      manifest: { name: 'Zorblex Helper', description: 'Draws things' },
      submittedByUserId: 5,
      forkOfAppBlockId: null,
    } as never);
    dbMock.dbRead.appListing.findFirst.mockResolvedValue(null as never);
    dbMock.dbRead.appListing.findMany.mockResolvedValue([] as never);
    dbMock.dbWrite.appReviewAgentReport.updateMany.mockResolvedValue({ count: 1 } as never);
  }

  it("merges the result into the report's security audit and adds the check's cost", async () => {
    seed({
      id: 'arar_1',
      status: 'complete',
      costUsd: 0.5,
      securityAudit: {
        findings: [{ severity: 'low', title: 'agent finding' }],
        impersonationCheck: { status: 'complete' },
      },
    });
    expect(await runImpersonationCheckForRequest(PUBREQ, { callModel: clearModel })).toBe(
      'checked'
    );

    const call = dbMock.dbWrite.appReviewAgentReport.updateMany.mock.calls[0][0] as {
      where: unknown;
      data: {
        securityAudit: {
          findings: Array<Record<string, unknown>>;
          impersonationCheck: { status: string };
        };
        costUsd: number;
      };
    };
    expect(call.where).toEqual({
      id: 'arar_1',
      status: { in: ['complete', 'failed', 'cost-capped'] },
    });
    expect(call.data.securityAudit.findings.map((f) => f.title)).toEqual([
      'agent finding',
      'Uses a protected brand name ("Zorblex")',
    ]);
    expect(call.data.securityAudit.impersonationCheck.status).toBe('complete');
    expect(call.data.costUsd).toBeCloseTo(0.502);
    // The name it judged is the manifest's, since the author has no listing yet.
    expect(clearModel.mock.calls[0][0].subject).toMatchObject({
      name: 'Zorblex Helper',
      description: 'Draws things',
    });
  });

  it("other authors' approved listings are what the name is compared against", async () => {
    seed({ id: 'arar_1', status: 'complete', costUsd: null, securityAudit: {} });
    await runImpersonationCheckForRequest(PUBREQ, { callModel: clearModel });
    const where = (dbMock.dbRead.appListing.findMany.mock.calls[0][0] as { where: unknown }).where;
    expect(where).toEqual({ status: 'approved', revisionOfId: null, NOT: { userId: 5 } });
    // No cost on the report → left alone (it is already counted at its cap).
    const data = (
      dbMock.dbWrite.appReviewAgentReport.updateMany.mock.calls[0][0] as { data: object }
    ).data;
    expect(data).not.toHaveProperty('costUsd');
  });

  it("reads the request's fork link and lowers a match against that parent to low", async () => {
    seed({ id: 'arar_1', status: 'complete', costUsd: null, securityAudit: {} });
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ v: 'ab_parent' }] as never);
    dbMock.dbRead.appListing.findMany.mockResolvedValue([
      { id: 'apl_p', name: 'Zorblex Helper', slug: 'parent', appBlockId: 'ab_parent' },
    ] as never);
    await runImpersonationCheckForRequest(PUBREQ, { callModel: clearModel });
    const data = (
      dbMock.dbWrite.appReviewAgentReport.updateMany.mock.calls[0][0] as {
        data: { securityAudit: { findings: Array<{ check: string; severity: string }> } };
      }
    ).data;
    expect(
      data.securityAudit.findings
        .filter((f) => f.check === 'listing-name-match')
        .map((f) => f.severity)
    ).toEqual(['low']);
  });

  it.each([null, { id: 'arar_1', status: 'running', costUsd: null, securityAudit: null }])(
    'no finished report (%o): nothing is written',
    async (report) => {
      seed(report);
      expect(await runImpersonationCheckForRequest(PUBREQ, { callModel: clearModel })).toBe(
        'no-report'
      );
      expect(dbMock.dbWrite.appReviewAgentReport.updateMany).not.toHaveBeenCalled();
    }
  );

  it('a database failure is reported, never thrown', async () => {
    dbMock.dbRead.appReviewAgentReport.findFirst.mockRejectedValue(new Error('db down'));
    expect(await runImpersonationCheckForRequest(PUBREQ, { callModel: clearModel })).toBe('error');
  });
});
