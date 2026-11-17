import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  countEvidenceHoldsEnding,
  listEvidenceHeldOwners,
  placeEvidenceHold,
  releaseEvidenceHold,
  recordModActivity,
} = vi.hoisted(() => ({
  countEvidenceHoldsEnding: vi.fn(),
  listEvidenceHeldOwners: vi.fn(),
  placeEvidenceHold: vi.fn(),
  releaseEvidenceHold: vi.fn(),
  recordModActivity: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('@civitai/db-queries/evidence-hold', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countEvidenceHoldsEnding,
  listEvidenceHeldOwners,
  placeEvidenceHold,
  releaseEvidenceHold,
}));
vi.mock('$lib/server/mod-activity', () => ({ recordModActivity }));

const { load, actions } = await import('../+page.server');
const { GENERATOR_EVIDENCE_HOLD_REASON } = await vi.importActual<
  typeof import('@civitai/db-queries/evidence-hold')
>('@civitai/db-queries/evidence-hold');

type LoadEvent = Parameters<typeof load>[0];

const loadAt = (query: string, grants: Record<string, boolean> = { 'csam.report.file': true }) =>
  load({
    url: new URL(`http://x/evidence-holds${query}`),
    locals: { grants },
  } as unknown as LoadEvent) as Promise<Record<string, unknown>>;

const endingOnly = () => listEvidenceHeldOwners.mock.calls[0][1].endingOnly;

beforeEach(() => {
  vi.clearAllMocks();
  countEvidenceHoldsEnding.mockResolvedValue({ owners: 2, earliest: new Date() });
  listEvidenceHeldOwners.mockResolvedValue({ items: [], hasMore: false });
});

describe('evidence holds load', () => {
  it('refuses a moderator without the csam permission before reading any hold', async () => {
    await expect(loadAt('', {})).rejects.toMatchObject({ status: 403 });
    expect(countEvidenceHoldsEnding).not.toHaveBeenCalled();
    expect(listEvidenceHeldOwners).not.toHaveBeenCalled();
  });

  it('opens on the ending owners while anyone is ending, and on everyone otherwise', async () => {
    await loadAt('');
    expect(endingOnly()).toBe(true);

    vi.clearAllMocks();
    countEvidenceHoldsEnding.mockResolvedValue({ owners: 0, earliest: null });
    listEvidenceHeldOwners.mockResolvedValue({ items: [], hasMore: false });
    await loadAt('');
    expect(endingOnly()).toBe(false);
  });

  it('keeps the filter the moderator picked', async () => {
    await loadAt('?ending=0&page=2');
    expect(listEvidenceHeldOwners.mock.calls[0][1]).toEqual({
      endingOnly: false,
      limit: 50,
      offset: 50,
    });

    vi.clearAllMocks();
    countEvidenceHoldsEnding.mockResolvedValue({ owners: 0, earliest: null });
    listEvidenceHeldOwners.mockResolvedValue({ items: [], hasMore: false });
    await loadAt('?ending=1');
    expect(endingOnly()).toBe(true);
  });

  it('hands the page the rows, the ending count and the filter it applied', async () => {
    const earliest = new Date('2026-11-01T00:00:00Z');
    const items = [{ userId: 7, username: 'a', heldUntil: earliest, holds: [] }];
    countEvidenceHoldsEnding.mockResolvedValue({ owners: 4, earliest });
    listEvidenceHeldOwners.mockResolvedValue({ items, hasMore: true });

    expect(await loadAt('?page=3')).toMatchObject({
      items,
      hasMore: true,
      page: 3,
      endingOnly: true,
      endingCount: 4,
      earliest,
      windowDays: 14,
      asOf: expect.any(Number),
    });
  });
});

const MOD = 7;
const post = (
  action: 'place' | 'release',
  fields: Record<string, string>,
  grants: Record<string, boolean> = { 'csam.report.file': true }
) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return (actions[action] as (e: unknown) => Promise<unknown>)({
    request: new Request('http://x/evidence-holds', { method: 'POST', body }),
    locals: { grants, user: { id: MOD } },
  }) as Promise<{ status?: number; data?: { error?: string } } & Record<string, unknown>>;
};

describe('placing a hold', () => {
  it('refuses a moderator without the csam permission and writes nothing', async () => {
    const result = await post('place', { userId: '5', reason: 'r' }, {});
    expect(result.status).toBe(403);
    expect(placeEvidenceHold).not.toHaveBeenCalled();
  });

  it('places a manual hold as the signed-in moderator, held through the chosen UTC day, and audits it', async () => {
    placeEvidenceHold.mockResolvedValue({ id: 41, created: true });
    const result = await post('place', {
      userId: '5',
      role: 'subject', // ignored: report-linked roles never come from this form
      reason: ' DMCA put-back ',
      releaseAt: '2099-01-15',
    });
    expect(placeEvidenceHold).toHaveBeenCalledWith(expect.anything(), {
      userId: 5,
      role: 'manual',
      reason: 'DMCA put-back',
      releaseAt: new Date('2099-01-16T00:00:00Z'), // held through the chosen day
      createdById: MOD,
    });
    expect(result).toMatchObject({ holdId: 41, created: true });
    expect(recordModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: MOD, entityId: 41, activity: 'placeEvidenceHold' })
    );
  });

  it('a repeat of an open hold is reported and not audited twice', async () => {
    placeEvidenceHold.mockResolvedValue({ id: 41, created: false });
    const result = await post('place', { userId: '5', reason: 'again' });
    expect(result).toMatchObject({ holdId: 41, created: false });
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('refuses a past end date, a bad user id, an empty reason and the reserved generator-evidence reason before writing', async () => {
    const refused: Record<string, string>[] = [
      { userId: '5', reason: 'r', releaseAt: '2001-01-01' },
      { userId: 'abc', reason: 'r' },
      { userId: '5', reason: '   ' },
      { userId: '5', reason: GENERATOR_EVIDENCE_HOLD_REASON },
    ];
    for (const fields of refused) {
      expect((await post('place', fields)).status).toBe(400);
    }
    expect(placeEvidenceHold).not.toHaveBeenCalled();
  });
});

describe('releasing a hold', () => {
  it('releases as the signed-in moderator with the reason, and audits it', async () => {
    releaseEvidenceHold.mockResolvedValue(true);
    const result = await post('release', { holdId: '41', releaseReason: 'restored' });
    expect(releaseEvidenceHold).toHaveBeenCalledWith(expect.anything(), {
      id: 41,
      releasedById: MOD,
      releaseReason: 'restored',
    });
    expect(result).toMatchObject({ holdId: 41 });
    expect(recordModActivity).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 41, activity: 'releaseEvidenceHold' })
    );
  });

  it('says so when the hold is already released, without auditing a release that did not happen', async () => {
    releaseEvidenceHold.mockResolvedValue(false);
    const result = await post('release', { holdId: '41', releaseReason: 'again' });
    expect(result.status).toBe(409);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('needs a reason and the csam permission', async () => {
    expect((await post('release', { holdId: '41', releaseReason: '' })).status).toBe(400);
    expect((await post('release', { holdId: '41', releaseReason: 'x' }, {})).status).toBe(403);
    expect(releaseEvidenceHold).not.toHaveBeenCalled();
  });
});
