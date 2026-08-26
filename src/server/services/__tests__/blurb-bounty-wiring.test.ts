import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as BlurbMaterializeService from '~/server/services/blurb-materialize.service';
import type * as RedisCaches from '~/server/redis/caches';
import type * as ImageIngestion from '~/server/services/image.service';

// The Bounty half of the blurb save path, run against the REAL `upsertBounty` /
// `applyBountyContentChange`. Only the blurb modules, the blocklist guard and the Redis-backed
// post-commit helpers are stubbed — with no live Redis those awaits never settle and the tests
// hang.
//
// Hoisted: bounty.service imports every module mocked below, so these factories run while this
// file's own imports are still resolving.
const {
  expandBlurbs,
  getReferencedBlurbIds,
  reconcileBlurbReferences,
  throwOnBlockedLinkDomain,
  enqueueImageIngestion,
  refreshUserBountyCount,
} = vi.hoisted(() => ({
  expandBlurbs: vi.fn(),
  getReferencedBlurbIds: vi.fn(),
  reconcileBlurbReferences: vi.fn(),
  throwOnBlockedLinkDomain: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  refreshUserBountyCount: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedLinkDomain,
}));
vi.mock('~/server/services/blurb-materialize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlurbMaterializeService>()),
  expandBlurbs,
  getReferencedBlurbIds,
  reconcileBlurbReferences,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageIngestion>()),
  enqueueImageIngestion,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisCaches>();
  return {
    ...actual,
    userBountyCountCache: { ...actual.userBountyCountCache, refresh: refreshUserBountyCount },
  };
});

import { applyBountyContentChange, upsertBounty } from '~/server/services/bounty.service';

const BOUNTY_ID = 41;
const OWNER_ID = 7;
const MODERATOR_ID = 9;

const CLIENT_HTML = '<span data-type="blurb" data-id="7">ATTACKER SUPPLIED</span>';
const EXPANDED_HTML = '<span data-type="blurb" data-id="7">REAL</span>';
const USES = [{ blurbId: 7, contentHash: 'h7' }];

const upsert = (input: Record<string, unknown> = {}) =>
  upsertBounty({
    id: BOUNTY_ID,
    userId: OWNER_ID,
    isModerator: false,
    name: 'A bounty',
    description: CLIENT_HTML,
    unitAmount: 5000,
    entryMode: 'Open',
    type: 'ModelCreation',
    mode: 'Individual',
    currency: 'BUZZ',
    startsAt: new Date(Date.now() + 86_400_000),
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    details: {},
    tags: [],
    files: [],
    images: [
      {
        url: '00000000-0000-0000-0000-000000000000',
        nsfw: 'None',
        width: 100,
        height: 100,
        hash: 'x',
        mimeType: 'image/png',
      },
    ],
    ...input,
  } as never);

/** The `$executeRaw` templates that write the description column, joined into readable SQL. */
function descriptionSql() {
  return dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings]) => (strings as string[]).join('?'))
    .filter((sql) => /UPDATE "Bounty"\s+SET description =/.test(sql));
}

beforeEach(() => {
  vi.clearAllMocks();
  expandBlurbs.mockResolvedValue({ evaluated: true, html: EXPANDED_HTML, uses: USES });
  getReferencedBlurbIds.mockResolvedValue([7]);
  reconcileBlurbReferences.mockResolvedValue(undefined);
  throwOnBlockedLinkDomain.mockResolvedValue(undefined);
  dbMock.dbRead.bounty.findUnique.mockResolvedValue({
    lockedProperties: [],
    userId: OWNER_ID,
  });
  dbMock.dbWrite.bounty.findUniqueOrThrow.mockResolvedValue({
    id: BOUNTY_ID,
    entryLimit: 1,
    complete: false,
    lockedProperties: [],
    _count: { entries: 0 },
  });
  dbMock.dbWrite.bounty.update.mockResolvedValue({
    id: BOUNTY_ID,
    userId: OWNER_ID,
    details: null,
  });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

describe('upsertBounty — blurb expansion', () => {
  it('stores what the blurb says, not the html the client sent', async () => {
    await upsert();

    const { data } = dbMock.dbWrite.bounty.update.mock.calls[0][0];
    expect(data.description).toBe(EXPANDED_HTML);
    expect(data.description).not.toContain('ATTACKER SUPPLIED');
  });

  it('re-checks blocked link domains against the EXPANDED html', async () => {
    await upsert();

    // The first guard saw the client's html. Drop the `data.description = expansion.html`
    // assignment and this second call re-checks the same unexpanded string, so a blocked domain
    // that arrived inside the blurb body is never seen.
    const checked = throwOnBlockedLinkDomain.mock.calls.map(([html]) => html);
    expect(checked).toEqual([CLIENT_HTML, EXPANDED_HTML]);
  });

  it('expands against the owner, not the moderator doing the saving', async () => {
    await upsert({ userId: MODERATOR_ID, isModerator: true });

    // A moderator's own blurb set resolves none of the owner's `data-id`s, so every span would be
    // unwrapped to plain text — a silent, permanent loss of the bounty's blurbs.
    expect(expandBlurbs).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER_ID, html: CLIENT_HTML })
    );
  });

  it('resolves only the blurbs the bounty already references when a moderator saves', async () => {
    await upsert({ userId: MODERATOR_ID, isModerator: true });

    expect(getReferencedBlurbIds).toHaveBeenCalledWith({
      entityType: 'Bounty',
      entityId: BOUNTY_ID,
    });
    expect(expandBlurbs).toHaveBeenCalledWith(expect.objectContaining({ restrictToBlurbIds: [7] }));
  });

  it('leaves the owner unrestricted', async () => {
    await upsert();

    expect(getReferencedBlurbIds).not.toHaveBeenCalled();
    expect(expandBlurbs).toHaveBeenCalledWith(
      expect.objectContaining({ restrictToBlurbIds: undefined })
    );
  });
});

describe('upsertBounty — blurb reconciliation', () => {
  it('reconciles after the write, against the bounty id', async () => {
    await upsert();

    expect(reconcileBlurbReferences).toHaveBeenCalledWith({
      entityType: 'Bounty',
      entityId: BOUNTY_ID,
      uses: USES,
    });

    const [write] = dbMock.dbWrite.bounty.update.mock.invocationCallOrder;
    const [reconcile] = reconcileBlurbReferences.mock.invocationCallOrder;
    expect(reconcile).toBeGreaterThan(write);
  });

  it('leaves an existing reference row alone when the flag is off for the owner', async () => {
    // Reconciling on an unevaluated expansion deletes EVERY reference row for the bounty, and the
    // fan-out — deliberately ungated so it can still maintain them — then has nothing left.
    expandBlurbs.mockResolvedValue({ evaluated: false, html: CLIENT_HTML });

    await upsert();

    expect(reconcileBlurbReferences).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.bounty.update).toHaveBeenCalled();
  });
});

describe('applyBountyContentChange', () => {
  it('writes the description column and nothing else', async () => {
    await applyBountyContentChange({ id: BOUNTY_ID, description: EXPANDED_HTML });

    // The fan-out calls this with nothing but new HTML. Route it back through the form-shaped
    // upsert and the failure mode is silent field loss — name, tags, files, images and the entry
    // limit cleared on every bounty the job touches.
    const [sql, ...extra] = descriptionSql();
    expect(extra).toEqual([]);
    expect(sql).toMatch(/WHERE id =/);
    expect(sql).not.toMatch(/name|tags|entryLimit|startsAt|expiresAt/);
  });

  it('writes through raw SQL so a re-materialization does not bump updatedAt', async () => {
    await applyBountyContentChange({ id: BOUNTY_ID, description: EXPANDED_HTML });

    // Prisma's @updatedAt would reorder every "recently updated" surface reading this column on
    // every blurb edit the owner makes.
    expect(descriptionSql()).toHaveLength(1);
    expect(dbMock.dbWrite.bounty.update).not.toHaveBeenCalled();
  });

  it('rejects a blocked link domain before writing anything', async () => {
    throwOnBlockedLinkDomain.mockRejectedValue(new Error('invalid urls: blocked.example'));

    await expect(
      applyBountyContentChange({ id: BOUNTY_ID, description: EXPANDED_HTML })
    ).rejects.toThrow('invalid urls');

    expect(descriptionSql()).toEqual([]);
  });

  it('reports a missing bounty rather than silently doing nothing', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);

    await expect(
      applyBountyContentChange({ id: BOUNTY_ID, description: EXPANDED_HTML })
    ).rejects.toThrow(/No bounty with id/);
  });
});
