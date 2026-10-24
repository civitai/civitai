import { describe, it, expect, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { toggleAnnouncementMute } from '../creator-announcement.service';

const MUTER = 7;
const CREATOR = 99;

/**
 * `changed` is what gates the analytics event, so it has to mean "this call moved the row"
 * and not "this call ran". A client re-sending the state it is already in — a double tap, a
 * retry, a stale toggle — must record nothing, or one muter becomes several mutes on the
 * creator's chart.
 */
describe('toggleAnnouncementMute reports whether it changed anything', () => {
  beforeEach(() => {
    // History as well as behaviour: the self-mute case asserts the write was NOT reached, and
    // calls from the tests above would satisfy that assertion on their own.
    dbMock.dbWrite.userAnnouncementMute.createMany.mockClear();
    dbMock.dbWrite.userAnnouncementMute.deleteMany.mockClear();
    dbMock.dbWrite.userAnnouncementMute.createMany.mockResolvedValue({ count: 0 });
    dbMock.dbWrite.userAnnouncementMute.deleteMany.mockResolvedValue({ count: 0 });
  });

  it('a first mute writes a row and reports the change', async () => {
    dbMock.dbWrite.userAnnouncementMute.createMany.mockResolvedValue({ count: 1 });

    await expect(
      toggleAnnouncementMute({ userId: MUTER, creatorId: CREATOR, muted: true })
    ).resolves.toEqual({ muted: true, changed: true });

    // The write is `skipDuplicates`, not a read-then-create: two concurrent mutes must not
    // both come back believing they were first.
    expect(dbMock.dbWrite.userAnnouncementMute.createMany).toHaveBeenCalledWith({
      data: { userId: MUTER, creatorId: CREATOR },
      skipDuplicates: true,
    });
  });

  it('muting again writes nothing and reports no change', async () => {
    dbMock.dbWrite.userAnnouncementMute.createMany.mockResolvedValue({ count: 0 });

    await expect(
      toggleAnnouncementMute({ userId: MUTER, creatorId: CREATOR, muted: true })
    ).resolves.toEqual({ muted: true, changed: false });
  });

  it('an unmute that removed a row reports the change', async () => {
    dbMock.dbWrite.userAnnouncementMute.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      toggleAnnouncementMute({ userId: MUTER, creatorId: CREATOR, muted: false })
    ).resolves.toEqual({ muted: false, changed: true });
    expect(dbMock.dbWrite.userAnnouncementMute.deleteMany).toHaveBeenCalledWith({
      where: { userId: MUTER, creatorId: CREATOR },
    });
  });

  it('unmuting when nothing was muted reports no change', async () => {
    await expect(
      toggleAnnouncementMute({ userId: MUTER, creatorId: CREATOR, muted: false })
    ).resolves.toEqual({ muted: false, changed: false });
  });

  it('refuses to let someone mute themselves, before any write', async () => {
    await expect(
      toggleAnnouncementMute({ userId: CREATOR, creatorId: CREATOR, muted: true })
    ).rejects.toThrow(/mute yourself/i);
    expect(dbMock.dbWrite.userAnnouncementMute.createMany).not.toHaveBeenCalled();
  });
});
