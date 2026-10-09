import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { awardBountyEntry } from '~/server/services/bountyEntry.service';
import { upsertBountyEntryHandler } from '~/server/controllers/bountyEntry.controller';
import type { ProtectedContext } from '~/server/createContext';

const BOUNTY_ID = 10;
const ENTRY_ID = 20;
const OWNER_ID = 1;
const ENTRANT_ID = 2;

loggingMock.logToAxiom.mockImplementation(() => Promise.resolve());

describe('awardBountyEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.bountyEntry.findUniqueOrThrow.mockResolvedValue({
      id: ENTRY_ID,
      bountyId: BOUNTY_ID,
      userId: OWNER_ID,
    });
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { userId: 3, complete: false, refunded: false, poi: false, availability: 'Public', meta: {} },
    ] as never);
  });

  it('refuses to let a benefactor award their own entry', async () => {
    await expect(awardBountyEntry({ id: ENTRY_ID, userId: OWNER_ID })).rejects.toThrow(
      "You can't award your own entry."
    );
    expect(dbMock.dbWrite.bountyBenefactor.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.bountyBenefactor.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it("lets a benefactor reach the award checks for someone else's entry", async () => {
    dbMock.dbWrite.bountyBenefactor.findUniqueOrThrow.mockResolvedValue({
      bountyId: BOUNTY_ID,
      userId: ENTRANT_ID,
      unitAmount: 100,
      currency: 'BUZZ',
      awardedToId: 999,
    });

    await expect(awardBountyEntry({ id: ENTRY_ID, userId: ENTRANT_ID })).rejects.toThrow(
      'Supporters have already awarded an entry.'
    );
    expect(dbMock.dbWrite.bountyBenefactor.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });
});

describe('upsertBountyEntryHandler', () => {
  const ctxFor = (userId: number) => ({ user: { id: userId } } as unknown as ProtectedContext);
  const input = { bountyId: BOUNTY_ID, files: [], images: [] } as unknown as Parameters<
    typeof upsertBountyEntryHandler
  >[0]['input'];

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      complete: false,
      entryLimit: 1,
      entries: [{ userId: ENTRANT_ID }],
    });
  });

  it('refuses an entry from the bounty owner', async () => {
    await expect(upsertBountyEntryHandler({ input, ctx: ctxFor(OWNER_ID) })).rejects.toThrow(
      'You cannot submit entries to your own bounty.'
    );
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    // The fake returns userId whatever is selected; without it in the real select the guard never fires.
    // entryLimit singles out the handler's own read: the visibility check also selects userId.
    expect(dbMock.dbRead.bounty.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ userId: true, entryLimit: true }),
      })
    );
  });

  it('lets the owner edit an entry that already exists', async () => {
    await upsertBountyEntryHandler({
      input: { ...input, id: ENTRY_ID },
      ctx: ctxFor(OWNER_ID),
    }).catch(() => null);
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
  });

  it('reaches the entry-limit check for anyone else', async () => {
    await expect(upsertBountyEntryHandler({ input, ctx: ctxFor(ENTRANT_ID) })).rejects.toThrow(
      'You have reached the maximum number of entries for this bounty'
    );
  });
});
