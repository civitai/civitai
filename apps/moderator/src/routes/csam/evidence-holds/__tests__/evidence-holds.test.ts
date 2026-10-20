import { beforeEach, describe, expect, it, vi } from 'vitest';

const { countEvidenceHoldsEnding, listEvidenceHeldOwners } = vi.hoisted(() => ({
  countEvidenceHoldsEnding: vi.fn(),
  listEvidenceHeldOwners: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('@civitai/db-queries/evidence-hold', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countEvidenceHoldsEnding,
  listEvidenceHeldOwners,
}));

const { load } = await import('../+page.server');

type LoadEvent = Parameters<typeof load>[0];

const loadAt = (query: string, grants: Record<string, boolean> = { 'csam.report.file': true }) =>
  load({
    url: new URL(`http://x/csam/evidence-holds${query}`),
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
  });
});
