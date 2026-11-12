import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { upsertBountyEntryHandler } from '~/server/controllers/bountyEntry.controller';
import type { ProtectedContext } from '~/server/createContext';
import { upsertBountyEntry } from '~/server/services/bountyEntry.service';

const BOUNTY_ID = 10;
const OWNER_ID = 1;
const ENTRANT_ID = 2;

type Entry = { id: number; bountyId: number; userId: number };

// A small model of Postgres for one bounty: entries become visible to other transactions only on
// commit, and `FOR UPDATE` on the Bounty row blocks until the holder's transaction ends. The
// controller's limit check reads committed entries outside any transaction, as it does in prod.
let committed: Entry[];
let entryLimit: number | null;
let lockedRowQueries: number;
let rowLock: Promise<void>;
// What the locked row says; the controller's earlier read always sees an open bounty, as when an
// award or refund commits between that read and the create.
let bountyComplete: boolean;
let bountyRowMissing: boolean;

function sqlText(strings: TemplateStringsArray | string) {
  return typeof strings === 'string' ? strings : strings.join('?');
}

function installFakeDb() {
  committed = [];
  lockedRowQueries = 0;
  bountyComplete = false;
  bountyRowMissing = false;
  rowLock = Promise.resolve();
  let nextId = 100;

  dbMock.dbRead.bounty.findUnique.mockImplementation(async () => ({
    userId: OWNER_ID,
    complete: false,
    entryLimit,
    entries: committed.map((e) => ({ userId: e.userId })),
  }));

  dbMock.dbWrite.$transaction.mockImplementation(async (fn: unknown) => {
    const staged: Entry[] = [];
    let release: (() => void) | undefined;
    const visible = () => [...committed, ...staged];

    const tx = {
      // Any read of the Bounty row gets the row; only a FOR UPDATE read waits for the lock, so a
      // missing lock shows up as an over-limit count, not as an empty result.
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = sqlText(strings);
        if (!/"Bounty"/.test(text)) return [];
        expect(values).toContain(BOUNTY_ID);
        if (/for update/i.test(text)) {
          lockedRowQueries++;
          const prev = rowLock;
          rowLock = new Promise<void>((r) => (release = r));
          await prev;
        }
        return bountyRowMissing ? [] : [{ entryLimit, complete: bountyComplete }];
      },
      bountyEntry: {
        count: async ({ where }: { where: { bountyId: number; userId: number } }) =>
          visible().filter((e) => e.bountyId === where.bountyId && e.userId === where.userId)
            .length,
        create: async ({ data }: { data: { bountyId: number; userId: number } }) => {
          const entry = { id: nextId++, bountyId: data.bountyId, userId: data.userId };
          staged.push(entry);
          return entry;
        },
        update: async ({ where }: { where: { id: number } }) => ({
          id: where.id,
          bountyId: BOUNTY_ID,
          userId: ENTRANT_ID,
        }),
      },
    };

    try {
      const result = await (fn as (t: typeof tx) => Promise<unknown>)(tx);
      // Give a parallel transaction the chance to read before this one commits.
      await new Promise((r) => setTimeout(r, 5));
      committed.push(...staged);
      return result;
    } finally {
      release?.();
    }
  });
}

const ctxFor = (userId: number) =>
  ({
    user: { id: userId },
    track: { bountyEntry: () => Promise.resolve() },
  } as unknown as ProtectedContext);

const submit = () =>
  upsertBountyEntryHandler({
    input: { bountyId: BOUNTY_ID } as never,
    ctx: ctxFor(ENTRANT_ID),
  });

describe('bounty entry limit under parallel submits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFakeDb();
  });

  it.each([
    [1, 2],
    [1, 3],
    [2, 4],
  ])('limit %i, %i parallel submits: only the limit lands', async (limit, submits) => {
    entryLimit = limit;

    const results = await Promise.allSettled(Array.from({ length: submits }, submit));

    expect(committed).toHaveLength(limit);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(submits - limit);
    for (const r of rejected)
      expect((r as PromiseRejectedResult).reason.message).toBe(
        'You have reached the maximum number of entries for this bounty'
      );
  });

  it('still lets a lone submit under the limit through', async () => {
    entryLimit = 1;
    await submit();
    expect(committed).toHaveLength(1);
  });

  it.each([0, null])(
    'lets entries through on a bounty with no limit (entryLimit %s)',
    async (limit) => {
      entryLimit = limit;
      committed.push({ id: 1, bountyId: BOUNTY_ID, userId: ENTRANT_ID });
      await Promise.all([submit(), submit()]);
      expect(committed).toHaveLength(3);
    }
  );

  it('refuses a new entry when the bounty row is gone', async () => {
    entryLimit = 1;
    bountyRowMissing = true;
    await expect(submit()).rejects.toThrow('Bounty not found');
    expect(committed).toHaveLength(0);
  });

  it('refuses a new entry when an award completed the bounty after the pre-check', async () => {
    entryLimit = 5;
    bountyComplete = true;
    await expect(submit()).rejects.toThrow('Bounty is already complete');
    expect(committed).toHaveLength(0);
  });

  it('does not take the bounty row lock when editing an entry', async () => {
    entryLimit = 1;
    await upsertBountyEntry({
      id: 55,
      bountyId: BOUNTY_ID,
      userId: ENTRANT_ID,
      description: undefined,
    } as never);
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(lockedRowQueries).toBe(0);
  });
});
