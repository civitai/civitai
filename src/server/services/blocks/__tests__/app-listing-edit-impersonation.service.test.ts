import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';
import type { ModelCall } from '~/server/services/blocks/app-impersonation-check.service';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as ReviewAutodeploy from '~/server/services/blocks/review-autodeploy.service';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import { impersonationFingerprint } from '~/server/services/blocks/app-impersonation.logic';

/**
 * The impersonation check on an APPROVED app's listing edit (a revision submitted for review):
 * it runs only when the edit changes the name, icon or cover, stores its result against the
 * listing request for the moderator queue, and counts its model spend in the daily
 * agent-review budget. Brand names are invented.
 */

const m = vi.hoisted(() => ({
  automationOn: true,
  terms: ['Zorblex'] as string[],
  recordSpend: vi.fn<(usd: number) => Promise<undefined>>(async () => undefined),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  getBlocklistData: vi.fn(async () => m.terms),
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  // The two flags read individually say ON; only the shared pair says OFF.
  isAppBlocksAgenticReviewAutostartEnabled: async () => true,
  isAppBlocksAgenticReviewEnabled: async () => true,
  isAgentReviewAutomationEnabled: async () => m.automationOn,
}));
vi.mock('~/server/services/blocks/review-autodeploy.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewAutodeploy>()),
  recordListingCheckSpendUsd: (usd: number) => m.recordSpend(usd),
}));

const {
  listingEditChanges,
  listingEditCheckKey,
  listingEditQueueChecks,
  runListingEditImpersonationCheck,
  startListingEditImpersonationCheck,
  summariseListingEditCheck,
} = await import('~/server/services/blocks/app-listing-edit-impersonation.service');

const model = vi.fn<ModelCall>(async () => ({
  judgement: { findings: [] as unknown[] },
  costUsd: 0.003,
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
  dbMock.dbWrite.appListingPublishRequest.findUnique.mockResolvedValue({
    id: ALPR,
    appListingId: 'apl_shadow',
    status: 'pending',
  } as never);
  const rows: Record<string, unknown> = {
    apl_shadow: shadow(opts.shadow),
    apl_parent: { ...parent, ...opts.parent },
  };
  dbMock.dbWrite.appListing.findUnique.mockImplementation(
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

  it('🔴 stores the fingerprint of the revision it judged (its text, icon and cover, under the PUBLIC slug)', async () => {
    seed({ shadow: { name: 'Zorblex Sketch', tagline: 'Draw', description: 'Draws' } });
    await runListingEditImpersonationCheck(ALPR, { callModel: model });
    const call = dbMock.dbWrite.keyValue.upsert.mock.calls[0][0] as {
      create: { value: { fingerprint?: string } };
    };
    expect(call.create.value.fingerprint).toBe(
      impersonationFingerprint({
        name: 'Zorblex Sketch',
        slug: 'sketch-helper',
        tagline: 'Draw',
        description: 'Draws',
        iconId: 10,
        coverId: 20,
      })
    );
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
    dbMock.dbWrite.appListingPublishRequest.findUnique.mockRejectedValue(new Error('db down'));
    expect(await runListingEditImpersonationCheck(ALPR, { callModel: model })).toBe('error');
  });
});

describe('🔴 startListingEditImpersonationCheck — gated, budgeted, and never silent', () => {
  const gate = (over: Record<string, unknown> = {}) => ({
    featureOn: async () => true,
    spendTodayUsd: async () => 1,
    dailyBudgetUsd: () => 40,
    ...over,
  });
  const run = vi.fn<(id: string) => Promise<'checked'>>(async () => 'checked');
  beforeEach(() => run.mockClear());
  const upserted = () =>
    dbMock.dbWrite.keyValue.upsert.mock.calls.map(
      (c) => (c[0] as { create: { value: { status: string; reason?: string } } }).create.value
    );

  it('feature flags OFF: nothing runs and nothing is stored (no badge from deploy)', async () => {
    seed({ shadow: { name: 'Zorblex Sketch' } });
    expect(
      await startListingEditImpersonationCheck(ALPR, {
        gate: gate({ featureOn: async () => false }),
        run,
      })
    ).toBe('disabled');
    expect(run).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.keyValue.upsert).not.toHaveBeenCalled();
  });

  it('🔴 by default it follows the ONE shared switch pair (isAgentReviewAutomationEnabled)', async () => {
    seed({ shadow: { name: 'Zorblex Sketch' } });
    m.automationOn = false;
    try {
      expect(
        await startListingEditImpersonationCheck(ALPR, {
          gate: { spendTodayUsd: async () => 0, dailyBudgetUsd: () => 40 },
          run,
        })
      ).toBe('disabled');
    } finally {
      m.automationOn = true;
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('an identity change writes a PENDING row synchronously, then starts the check', async () => {
    seed({ shadow: { name: 'Zorblex Sketch' } });
    expect(await startListingEditImpersonationCheck(ALPR, { gate: gate(), run })).toBe('started');
    expect(upserted()).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(run).toHaveBeenCalledWith(ALPR);
  });

  it('the daily budget is spent: refused, and the row says so', async () => {
    seed({ shadow: { name: 'Zorblex Sketch' } });
    expect(
      await startListingEditImpersonationCheck(ALPR, {
        gate: gate({ spendTodayUsd: async () => 40 }),
        run,
      })
    ).toBe('skipped-budget');
    expect(upserted()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'budget' })]);
    expect(run).not.toHaveBeenCalled();
  });

  it('no identity change: nothing stored, nothing run', async () => {
    seed({ shadow: { tagline: 'new' } });
    expect(await startListingEditImpersonationCheck(ALPR, { gate: gate(), run })).toBe('unchanged');
    expect(dbMock.dbWrite.keyValue.upsert).not.toHaveBeenCalled();
  });
});

describe('summariseListingEditCheck / listingEditQueueChecks', () => {
  const stored = (status: string, severities: Array<string | undefined>, extra = {}) => ({
    status,
    changed: ['name'],
    record: { status },
    findings: severities.map((severity, i) => ({ severity, title: `finding ${i}` })),
    ...extra,
  });

  it('counts medium-or-worse findings — and findings with no severity — and keeps their titles', () => {
    expect(
      summariseListingEditCheck(stored('complete', ['medium', 'low', 'high', undefined]))
    ).toEqual({
      status: 'complete',
      flagging: 3,
      titles: ['finding 0', 'finding 2', 'finding 3'],
    });
  });

  it.each([
    ['pending', 'pending'],
    ['skipped', 'skipped'],
    ['failed', 'failed'],
    ['weird', 'failed'],
  ])('a stored %s row reads as %s', (status, expected) => {
    expect(summariseListingEditCheck(stored(status, [])).status).toBe(expected);
  });

  it('a malformed stored value reads as a FAILED check, never as clear', () => {
    expect(summariseListingEditCheck({ nonsense: true }).status).toBe('failed');
  });

  const page = [
    { id: 'alpr_hit', appListingId: 'apl_s1' },
    { id: 'alpr_nochange', appListingId: 'apl_s2' },
    { id: 'alpr_lost', appListingId: 'apl_s3' },
    { id: 'alpr_new', appListingId: 'apl_new' },
  ];
  function seedQueue() {
    const parentRow = { name: 'Sketch', iconId: 1, coverId: 2, status: 'approved' };
    dbMock.dbRead.appListing.findMany.mockResolvedValue([
      { id: 'apl_s1', name: 'Zorblex', iconId: 1, coverId: 2, revisionOf: parentRow },
      { id: 'apl_s2', name: 'Sketch', iconId: 1, coverId: 2, revisionOf: parentRow },
      { id: 'apl_s3', name: 'Sketch', iconId: 9, coverId: 2, revisionOf: parentRow },
      // A first listing (not a revision of an approved app) is not this check's business.
      { id: 'apl_new', name: 'Zorblex', iconId: 1, coverId: 2, revisionOf: null },
    ] as never);
    dbMock.dbRead.keyValue.findMany.mockResolvedValue([
      { key: listingEditCheckKey('alpr_hit'), value: stored('complete', ['high']) },
    ] as never);
  }

  it('🔴 an identity-changing edit with NO stored row reads as missing (never as no-change)', async () => {
    seedQueue();
    const map = await listingEditQueueChecks(page, { featureOn: async () => true });
    expect(map.get('alpr_hit')?.flagging).toBe(1);
    expect(map.get('alpr_lost')?.status).toBe('missing');
    expect(map.has('alpr_nochange')).toBe(false);
    expect(map.has('alpr_new')).toBe(false);
  });

  it('🔴 a revision edited AFTER a clean check (new icon) reads as STALE, not complete', async () => {
    const parentRow = { name: 'Sketch', slug: 'sketch', iconId: 1, coverId: 2, status: 'approved' };
    const shadowAtCheck = {
      id: 'apl_s1',
      name: 'Sketch Pro',
      tagline: null,
      description: null,
      iconId: 1,
      coverId: 2,
      revisionOf: parentRow,
    };
    const fpAtCheck = impersonationFingerprint({ ...shadowAtCheck, slug: 'sketch' });
    dbMock.dbRead.keyValue.findMany.mockResolvedValue([
      {
        key: listingEditCheckKey('alpr_hit'),
        value: { ...stored('complete', []), fingerprint: fpAtCheck },
      },
    ] as never);

    // Unchanged since the check: complete, nothing to flag.
    dbMock.dbRead.appListing.findMany.mockResolvedValue([shadowAtCheck] as never);
    const fresh = await listingEditQueueChecks([{ id: 'alpr_hit', appListingId: 'apl_s1' }], {
      featureOn: async () => true,
    });
    expect(fresh.get('alpr_hit')?.status).toBe('complete');

    // The author swapped the icon on the pending revision afterwards.
    dbMock.dbRead.appListing.findMany.mockResolvedValue([
      { ...shadowAtCheck, iconId: 77 },
    ] as never);
    const edited = await listingEditQueueChecks([{ id: 'alpr_hit', appListingId: 'apl_s1' }], {
      featureOn: async () => true,
    });
    expect(edited.get('alpr_hit')?.status).toBe('stale');
  });

  it('feature flags OFF: no listing-edit badges at all', async () => {
    seedQueue();
    const map = await listingEditQueueChecks(page, { featureOn: async () => false });
    expect(map.size).toBe(0);
  });
});
