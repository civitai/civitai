import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `listMyAppListings` — the TRUST-LINK nudges (`no-source-repo` / `no-issue-tracker`).
 *
 * 🔴 A PRE-APPROVAL ON-SITE DRAFT GETS NO LINK NUDGE. Its links are manifest-governed and reach
 * the listing row only at approve, so its columns are empty whatever the submitted manifest
 * says. Reading them would tell an author whose manifest already sets `repository` / `bugs` to
 * set them and resubmit. This surface has no manifest for such a draft, so it reports nothing.
 * An approved on-site listing and an off-site draft are the positive controls: their columns
 * ARE the truth, so the nudge must still fire for them.
 */

const mockDb = dbMock.dbRead;
const { listMyAppListings } = await import('~/server/services/blocks/app-access.service');

const OWNER = 11;

type Stored = Record<string, unknown> & { id: string; kind: string; status: string };

function stored(over: Partial<Stored> & { id: string; kind: string; status: string }): Stored {
  return {
    slug: `slug-${over.id}`,
    name: `Name ${over.id}`,
    appBlockId: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    icon: { url: 'icon-uuid' },
    cover: { url: 'cover-uuid' },
    iconId: 41,
    coverId: 53,
    description: 'd',
    tagline: 't',
    category: 'utility',
    contentRating: 'g',
    _count: { screenshots: 7 },
    columnUserId: OWNER,
    ...over,
  };
}

function findManyFake(table: Stored[]) {
  return async (...a: unknown[]): Promise<unknown[]> => {
    const args = (a[0] ?? {}) as {
      where?: { OR?: Array<Record<string, unknown>>; id?: { in: string[] } };
      select?: Record<string, unknown>;
    };
    let rows = table;
    if (args.where?.id?.in) rows = rows.filter((r) => args.where!.id!.in.includes(r.id));
    if (args.where?.OR) rows = rows.filter((r) => r.columnUserId === OWNER);
    return rows.map((r) => {
      if (!args.select) return { ...r };
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(args.select)) if (args.select[key]) out[key] = r[key];
      return out;
    });
  };
}

/** Both link columns readable and EMPTY for every listing on the page. */
function armEmptyLinkColumns(ids: string[]) {
  mockDb.$queryRaw.mockImplementation(async (strings: unknown) => {
    const text = Array.isArray(strings) ? (strings as string[]).join('?') : '';
    if (text.includes('source_repo_url')) return ids.map((id) => ({ id, sourceRepoUrl: null }));
    if (text.includes('issue_tracker_url')) return ids.map((id) => ({ id, issueTrackerUrl: null }));
    return [];
  });
}

async function linkCodes(id: string): Promise<string[]> {
  const rows = await listMyAppListings({ userId: OWNER });
  const row = rows.find((r) => r.appListingId === id);
  expect(row, `no row for ${id}`).toBeDefined();
  return row!.problems
    .map((p) => p.code)
    .filter((c) => c === 'no-source-repo' || c === 'no-issue-tracker');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appListing.findMany.mockImplementation(async () => []);
  mockDb.appCollaborator.findMany.mockImplementation(async () => []);
  mockDb.appListingScreenshot.findMany.mockImplementation(async () => []);
  mockDb.image.findMany.mockImplementation(async () => []);
});

describe('listMyAppListings — trust-link nudges', () => {
  const approvedOnsite = stored({
    id: 'l-on-live',
    kind: 'onsite',
    status: 'approved',
    appBlockId: 'ab_live',
  });
  const onsiteDraft = stored({ id: 'l-on-draft', kind: 'onsite', status: 'draft' });
  const offsiteDraft = stored({ id: 'l-off-draft', kind: 'offsite', status: 'draft' });
  const page = [approvedOnsite, onsiteDraft, offsiteDraft];

  beforeEach(() => {
    mockDb.appListing.findMany.mockImplementation(findManyFake(page));
    armEmptyLinkColumns(page.map((r) => r.id));
  });

  it('POSITIVE CONTROL: an APPROVED on-site listing with empty columns gets both nudges', async () => {
    expect(await linkCodes('l-on-live')).toEqual(['no-source-repo', 'no-issue-tracker']);
  });

  it('POSITIVE CONTROL: an OFF-SITE draft gets both nudges (its columns are the form)', async () => {
    expect(await linkCodes('l-off-draft')).toEqual(['no-source-repo', 'no-issue-tracker']);
  });

  it('🔴 a PRE-APPROVAL ON-SITE draft gets NEITHER nudge — its manifest is not on this surface', async () => {
    expect(await linkCodes('l-on-draft')).toEqual([]);
  });
});
