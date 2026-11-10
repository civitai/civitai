import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';
import type { ModelCall } from '~/server/services/blocks/app-impersonation-check.service';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as ReviewAutodeploy from '~/server/services/blocks/review-autodeploy.service';

/**
 * The impersonation check on an APPROVED app's listing edit (a revision submitted for review):
 * it runs only when the edit changes the name, icon or cover, stores its result against the
 * listing request for the moderator queue, and counts its model spend in the daily
 * agent-review budget. Brand names are invented.
 */

const m = vi.hoisted(() => ({
  terms: ['Zorblex'] as string[],
  recordSpend: vi.fn(async (_usd: number) => undefined),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  getBlocklistData: vi.fn(async () => m.terms),
}));
vi.mock('~/server/services/blocks/review-autodeploy.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewAutodeploy>()),
  recordListingCheckSpendUsd: (usd: number) => m.recordSpend(usd),
}));

const {
  listingEditChanges,
  listingEditCheckKey,
  listingEditCheckSummaries,
  runListingEditImpersonationCheck,
  summariseListingEditCheck,
} = await import('~/server/services/blocks/app-listing-edit-impersonation.service');

type ModelArgs = Parameters<ModelCall>[0];
const model = vi.fn(async (_args: ModelArgs) => ({
  judgement: { findings: [] as unknown[] },
  costUsd: 0.003 as number | null,
}));

const ALPR = 'alpr_01';
const parent = {
  id: 'apl_parent',
  name: 'Sketch Helper',
  slug: 'sketch-helper',
  status: 'approved',
  iconId: 10,
  coverId: 20,
  userId: 5,
};
const shadow = (over: Record<string, unknown> = {}) => ({
  id: 'apl_shadow',
  name: 'Sketch Helper',
  tagline: null,
  description: null,
  iconId: 10,
  coverId: 20,
  revisionOfId: 'apl_parent',
  icon: { url: 'icon-uuid' },
  cover: { url: 'cover-uuid' },
  ...over,
});

function seed(opts: { shadow?: Record<string, unknown>; parent?: Record<string, unknown> } = {}) {
  dbMock.dbRead.appListingPublishRequest.findUnique.mockResolvedValue({
    id: ALPR,
    appListingId: 'apl_shadow',
    status: 'pending',
  } as never);
  const rows: Record<string, unknown> = {
    apl_shadow: shadow(opts.shadow),
    apl_parent: { ...parent, ...opts.parent },
  };
  dbMock.dbRead.appListing.findUnique.mockImplementation(
    (async (args: { where: { id: string } }) => rows[args.where.id] ?? null) as never
  );
  dbMock.dbRead.appListing.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.keyValue.upsert.mockResolvedValue({} as never);
}

beforeEach(() => {
  resetHybridNodes();
  m.terms = ['Zorblex'];
  m.recordSpend.mockClear();
  model.mockClear();
});

describe('listingEditChanges', () => {
  it('names exactly the identity fields that changed', () => {
    const base = { name: 'A', iconId: 1, coverId: 2 };
    expect(listingEditChanges(base, base)).toEqual([]);
    expect(listingEditChanges(base, { ...base, name: 'B' })).toEqual(['name']);
    expect(listingEditChanges(base, { name: 'B', iconId: 9, coverId: 8 })).toEqual([
      'name',
      'icon',
      'cover',
    ]);
    expect(listingEditChanges(base, { ...base, coverId: null })).toEqual(['cover']);
  });
});

describe('runListingEditImpersonationCheck', () => {
  it('🔴 a renamed approved app hitting a protected term: result stored for the queue, spend counted', async () => {
    seed({ shadow: { name: 'Zorblex Sketch' } });
    expect(await runListingEditImpersonationCheck(ALPR, { callModel: model })).toBe('checked');

    const call = dbMock.dbWrite.keyValue.upsert.mock.calls[0][0] as {
      where: { key: string };
      create: {
        key: string;
        value: {
          changed: string[];
          record: { status: string };
          findings: Array<{ check: string; severity: string }>;
        };
      };
    };
    expect(call.where.key).toBe(listingEditCheckKey(ALPR));
    expect(call.create.value.changed).toEqual(['name']);
    expect(call.create.value.record.status).toBe('complete');
    expect(call.create.value.findings.map((f) => [f.check, f.severity])).toEqual([
      ['protected-term', 'medium'],
    ]);
    expect(m.recordSpend).toHaveBeenCalledWith(0.003);
    // The model judged the NEW listing under its PUBLIC slug.
    expect(model.mock.calls[0][0].subject).toMatchObject({
      name: 'Zorblex Sketch',
      slug: 'sketch-helper',
    });
  });

  it('an icon-only change is checked too, with the new icon handed to the model', async () => {
    seed({ shadow: { iconId: 11 } });
    expect(await runListingEditImpersonationCheck(ALPR, { callModel: model })).toBe('checked');
    expect(model.mock.calls[0][0].iconUrl).toContain('icon-uuid');
  });

  it("the name is compared against other authors' approved listings, never the app's own", async () => {
    seed({ shadow: { name: 'Zorblex Sketch' } });
    await runListingEditImpersonationCheck(ALPR, { callModel: model });
    const where = (dbMock.dbRead.appListing.findMany.mock.calls[0][0] as { where: unknown }).where;
    expect(where).toEqual({ status: 'approved', revisionOfId: null, NOT: { userId: 5 } });
  });

  it('🔴 no name/icon/cover change: no check, nothing stored (today’s behaviour)', async () => {
    seed({ shadow: { tagline: 'new tagline' } });
    expect(await runListingEditImpersonationCheck(ALPR, { callModel: model })).toBe('unchanged');
    expect(model).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.keyValue.upsert).not.toHaveBeenCalled();
  });

  it('not a revision of an APPROVED listing: not applicable', async () => {
    seed({ shadow: { name: 'Zorblex Sketch' }, parent: { status: 'removed' } });
    expect(await runListingEditImpersonationCheck(ALPR, { callModel: model })).toBe(
      'not-applicable'
    );
    seed({ shadow: { name: 'Zorblex Sketch', revisionOfId: null } });
    expect(await runListingEditImpersonationCheck(ALPR, { callModel: model })).toBe(
      'not-applicable'
    );
    expect(model).not.toHaveBeenCalled();
  });

  it('a model failure still stores a FAILED record (so a person checks it by hand)', async () => {
    seed({ shadow: { name: 'Other Name' } });
    await runListingEditImpersonationCheck(ALPR, {
      callModel: async () => {
        throw new Error('provider 500');
      },
    });
    const call = dbMock.dbWrite.keyValue.upsert.mock.calls[0][0] as {
      create: { value: { record: { status: string } } };
    };
    expect(call.create.value.record.status).toBe('failed');
    expect(m.recordSpend).not.toHaveBeenCalled();
  });

  it('a database failure is reported, never thrown', async () => {
    dbMock.dbRead.appListingPublishRequest.findUnique.mockRejectedValue(new Error('db down'));
    expect(await runListingEditImpersonationCheck(ALPR, { callModel: model })).toBe('error');
  });
});

describe('summariseListingEditCheck / listingEditCheckSummaries', () => {
  const stored = (status: string, severities: string[]) => ({
    changed: ['name'],
    record: { status },
    findings: severities.map((severity, i) => ({ severity, title: `finding ${i}` })),
  });

  it('counts medium-or-worse findings and keeps their titles', () => {
    expect(summariseListingEditCheck(stored('complete', ['medium', 'low', 'high']))).toEqual({
      status: 'complete',
      flagging: 2,
      titles: ['finding 0', 'finding 2'],
    });
    expect(summariseListingEditCheck(stored('failed', []))).toEqual({
      status: 'failed',
      flagging: 0,
      titles: [],
    });
  });

  it('a malformed stored value reads as a FAILED check, never as clear', () => {
    expect(summariseListingEditCheck({ nonsense: true })).toEqual({
      status: 'failed',
      flagging: 0,
      titles: [],
    });
  });

  it('reads one page of requests in one query, keyed by request id', async () => {
    dbMock.dbRead.keyValue.findMany.mockResolvedValue([
      { key: listingEditCheckKey('alpr_a'), value: stored('complete', ['high']) },
    ] as never);
    const map = await listingEditCheckSummaries(['alpr_a', 'alpr_b']);
    expect(dbMock.dbRead.keyValue.findMany).toHaveBeenCalledTimes(1);
    expect(map.get('alpr_a')?.flagging).toBe(1);
    expect(map.has('alpr_b')).toBe(false);
  });
});
