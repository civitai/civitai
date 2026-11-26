import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAppealDetails } from '~/server/services/report.service';
import { EntityType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const findAppeal = dbMock.dbRead.appeal.findUnique;
const findImage = dbMock.dbRead.image.findUnique;

const OWNER = 10;
const appeal = { id: 1, userId: OWNER, entityType: EntityType.Image, entityId: 55 };

const selectArg = () =>
  (findAppeal.mock.calls[0][0] as { select: Record<string, boolean | undefined> }).select;

beforeEach(() => {
  vi.clearAllMocks();
  findAppeal.mockResolvedValue(appeal);
  findImage.mockResolvedValue({ id: 55, url: 'u', userId: OWNER });
});

describe('getAppealDetails', () => {
  it("is not found for another user's appeal", async () => {
    await expect(getAppealDetails({ id: 1, userId: 99 })).rejects.toThrow('Appeal not found');
  });

  it('returns the appeal to its owner without moderator-only fields', async () => {
    await expect(getAppealDetails({ id: 1, userId: OWNER })).resolves.toMatchObject({ id: 1 });
    expect(selectArg().internalNotes).toBeFalsy();
    expect(selectArg().resolvedBy).toBeFalsy();
  });

  it('returns any appeal, with moderator-only fields, to a moderator', async () => {
    await expect(getAppealDetails({ id: 1, userId: 99, isModerator: true })).resolves.toMatchObject(
      { id: 1 }
    );
    expect(selectArg().internalNotes).toBe(true);
  });

  it("reads an appealed image's url for a moderator only", async () => {
    const imageSelect = () =>
      (findImage.mock.calls.at(-1)![0] as { select: Record<string, boolean> }).select;
    await getAppealDetails({ id: 1, userId: OWNER });
    expect(imageSelect()).toEqual({ id: true, url: false, userId: true });
    await getAppealDetails({ id: 1, userId: 99, isModerator: true });
    expect(imageSelect()).toEqual({ id: true, url: true, userId: true });
  });

  it("returns the appealed image's url to a moderator and not to its owner", async () => {
    // A fake that honours `select`, as Prisma does: the response is what the select asks for.
    const row: Record<string, unknown> = { id: 55, url: 'u', userId: OWNER };
    findImage.mockImplementation((async ({ select }: { select: Record<string, boolean> }) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => select[key]))) as never);
    const ownerView = await getAppealDetails({ id: 1, userId: OWNER });
    expect(ownerView.entityDetails).toEqual({ id: 55, userId: OWNER });
    const modView = await getAppealDetails({ id: 1, userId: 99, isModerator: true });
    expect(modView.entityDetails).toEqual({ id: 55, url: 'u', userId: OWNER });
  });
});
