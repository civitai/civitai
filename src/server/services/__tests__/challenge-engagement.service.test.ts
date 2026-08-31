import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { getExcluded } = vi.hoisted(() => ({
  getExcluded: vi.fn(async (..._a: unknown[]): Promise<number[]> => []),
}));

// One local used to serve both clients, so a write satisfied a read assertion. Each call site is
// now routed to the client `challenge-engagement.service` actually spells for it.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
// `create`/`delete` have no canonical default; the service reads the returned row.
mockDbWrite.challengeEngagement.create.mockResolvedValue({});
mockDbWrite.challengeEngagement.delete.mockResolvedValue({});
vi.mock('~/server/services/challenge-block.service', () => ({
  getChallengeExcludedUserIds: getExcluded,
}));

import {
  toggleChallengeNotify,
  getChallengeNotifyRecipients,
  getChallengeReminderRecipients,
} from '~/server/services/challenge-engagement.service';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '1',
    meta: { target: ['type', 'challengeId', 'userId'] },
  });

const PAST = new Date('2020-01-01T00:00:00Z');
const FUTURE = new Date('2999-01-01T00:00:00Z');

const openChallenge = {
  id: 7,
  status: 'Scheduled',
  source: 'User',
  createdById: 99,
  ingestion: 'Scanned',
  visibleAt: PAST,
  coverImage: { nsfwLevel: 1 },
};

// resetAllMocks (not clearAllMocks) because several cases queue a `...Once` on a mock the
// code path then short-circuits past — clearAllMocks leaves that queued value armed for the
// next test, which silently mis-targets whichever gate runs first.
beforeEach(() => {
  vi.resetAllMocks();
  mockDbRead.challenge.findUnique.mockResolvedValue(openChallenge);
  mockDbRead.challengeEngagement.findUnique.mockResolvedValue(null);
  mockDbWrite.challengeEngagement.create.mockResolvedValue({});
  mockDbWrite.challengeEngagement.delete.mockResolvedValue({});
  mockDbRead.challengeEngagement.findMany.mockResolvedValue([]);
  mockDbRead.user.findUnique.mockResolvedValue({ browsingLevel: 1 });
  mockDbRead.$queryRaw.mockResolvedValue([]);
  getExcluded.mockResolvedValue([]);
});

describe('toggleChallengeNotify', () => {
  it('creates a Notify row and returns true when none exists', async () => {
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce(null);

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42 });

    expect(result).toBe(true);
    expect(mockDbWrite.challengeEngagement.create).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.challengeEngagement.create).toHaveBeenCalledWith({
      data: { type: 'Notify', challengeId: 7, userId: 42 },
    });
  });

  it('deletes the row and returns false when one exists (blind toggle off)', async () => {
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42 });

    expect(result).toBe(false);
    expect(mockDbWrite.challengeEngagement.delete).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.challengeEngagement.delete).toHaveBeenCalledWith({
      where: { type_challengeId_userId: { type: 'Notify', challengeId: 7, userId: 42 } },
    });
  });

  it('explicit setTo:true on an existing row is an idempotent no-op, never a delete', async () => {
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42, setTo: true });

    expect(result).toBe(true);
    expect(mockDbWrite.challengeEngagement.delete).not.toHaveBeenCalled();
    expect(mockDbWrite.challengeEngagement.create).not.toHaveBeenCalled();
  });

  it('P2002 on create resolves to true instead of bubbling a 500', async () => {
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce(null);
    mockDbWrite.challengeEngagement.create.mockRejectedValueOnce(p2002());

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42 });

    expect(result).toBe(true);
  });

  it('rethrows a non-P2002 create error', async () => {
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce(null);
    mockDbWrite.challengeEngagement.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow(
      'connection reset'
    );
  });

  it('rejects tracking a challenge that does not exist', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce(null);

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow();
    expect(mockDbWrite.challengeEngagement.create).not.toHaveBeenCalled();
  });

  it('rejects tracking a challenge whose creator the viewer has blocked', async () => {
    getExcluded.mockResolvedValueOnce([99]);

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow();
    expect(mockDbWrite.challengeEngagement.create).not.toHaveBeenCalled();
  });

  it('allows untracking a Completed challenge even though tracking it is closed', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      ...openChallenge,
      status: 'Completed',
    });
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42, setTo: false });

    expect(result).toBe(false);
    expect(mockDbWrite.challengeEngagement.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects newly tracking a Completed challenge', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      ...openChallenge,
      status: 'Completed',
    });
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce(null);

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow();
  });

  it('rejects tracking a User-sourced challenge whose creator is excluded', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      ...openChallenge,
      source: 'User',
    });
    getExcluded.mockResolvedValueOnce([99]);

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow();
    expect(mockDbWrite.challengeEngagement.create).not.toHaveBeenCalled();
  });

  it('allows tracking a System-sourced challenge even when its (shared judge) createdById is excluded', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      ...openChallenge,
      source: 'System',
    });
    getExcluded.mockResolvedValueOnce([99]);
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce(null);

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42 });

    expect(result).toBe(true);
    expect(mockDbWrite.challengeEngagement.create).toHaveBeenCalledTimes(1);
  });

  // Challenge ids are sequential, so the toggle endpoint must apply the same visibility gates the
  // feed and detail page do — otherwise it both confirms a hidden challenge exists and subscribes
  // the caller to notifications naming it.
  it('rejects tracking a challenge whose cover level the viewer cannot see', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      ...openChallenge,
      coverImage: { nsfwLevel: 8 },
    });
    mockDbRead.user.findUnique.mockResolvedValueOnce({ browsingLevel: 1 });

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow(
      'Challenge not found'
    );
    expect(mockDbWrite.challengeEngagement.create).not.toHaveBeenCalled();
  });

  it('allows tracking when the cover level intersects the viewer browsing level', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      ...openChallenge,
      coverImage: { nsfwLevel: 4 },
    });
    mockDbRead.user.findUnique.mockResolvedValueOnce({ browsingLevel: 5 });
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce(null);

    expect(await toggleChallengeNotify({ challengeId: 7, userId: 42 })).toBe(true);
    expect(mockDbWrite.challengeEngagement.create).toHaveBeenCalledWith({
      data: { type: 'Notify', challengeId: 7, userId: 42 },
    });
  });

  it('rejects tracking a user challenge that has not passed the moderation scan', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      ...openChallenge,
      ingestion: 'Pending',
    });

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow(
      'Challenge not found'
    );
    expect(mockDbWrite.challengeEngagement.create).not.toHaveBeenCalled();
  });

  it('rejects tracking a user challenge that is not yet visible', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      ...openChallenge,
      visibleAt: FUTURE,
    });

    await expect(toggleChallengeNotify({ challengeId: 7, userId: 42 })).rejects.toThrow(
      'Challenge not found'
    );
    expect(mockDbWrite.challengeEngagement.create).not.toHaveBeenCalled();
  });

  it('lets the creator track their own unscanned, not-yet-visible challenge', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      ...openChallenge,
      createdById: 42,
      ingestion: 'Pending',
      visibleAt: FUTURE,
      coverImage: { nsfwLevel: 8 },
    });
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce(null);

    expect(await toggleChallengeNotify({ challengeId: 7, userId: 42 })).toBe(true);
    expect(mockDbWrite.challengeEngagement.create).toHaveBeenCalledWith({
      data: { type: 'Notify', challengeId: 7, userId: 42 },
    });
  });

  it('does not apply the scan/visibility gate to System challenges', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      ...openChallenge,
      source: 'System',
      ingestion: 'Pending',
      visibleAt: FUTURE,
    });
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce(null);

    expect(await toggleChallengeNotify({ challengeId: 7, userId: 42 })).toBe(true);
  });

  it('does not run the visibility gates when untracking', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({
      ...openChallenge,
      ingestion: 'Pending',
      coverImage: { nsfwLevel: 8 },
    });
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    expect(await toggleChallengeNotify({ challengeId: 7, userId: 42, setTo: false })).toBe(false);
    expect(mockDbWrite.challengeEngagement.delete).toHaveBeenCalledTimes(1);
  });

  it('allows untracking even when the creator is in the excluded set', async () => {
    getExcluded.mockResolvedValueOnce([99]);
    mockDbRead.challengeEngagement.findUnique.mockResolvedValueOnce({ type: 'Notify' });

    const result = await toggleChallengeNotify({ challengeId: 7, userId: 42, setTo: false });

    expect(result).toBe(false);
    expect(mockDbWrite.challengeEngagement.delete).toHaveBeenCalledTimes(1);
  });
});

describe('recipient resolution', () => {
  it('getChallengeNotifyRecipients returns tracker ids only', async () => {
    mockDbRead.challengeEngagement.findMany.mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }]);

    expect(await getChallengeNotifyRecipients(7)).toEqual([1, 2]);
    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('getChallengeReminderRecipients unions trackers with entrants, de-duplicated', async () => {
    // beforeEach's default challenge has no collectionId, which would short-circuit the entrant query.
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({ collectionId: 5 });
    mockDbRead.challengeEngagement.findMany.mockResolvedValueOnce([{ userId: 1 }, { userId: 2 }]);
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ userId: 2 }, { userId: 3 }]);

    const result = await getChallengeReminderRecipients(7);

    expect([...result].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  // A user whose only entry was rejected already got challenge-rejection and is out of the running,
  // so they must not be swept in as an entrant — same statuses the feed's Entered filter uses.
  it('getChallengeReminderRecipients counts only accepted/in-review entries as entrants', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({ collectionId: 5 });
    mockDbRead.challengeEngagement.findMany.mockResolvedValueOnce([]);
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);

    await getChallengeReminderRecipients(7);

    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('')).toContain('ci.status IN (');
    expect(values).toContain('ACCEPTED');
    expect(values).toContain('REVIEW');
  });

  it('getChallengeReminderRecipients skips the entrant query when the challenge has no collection', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValueOnce({ collectionId: null });
    mockDbRead.challengeEngagement.findMany.mockResolvedValueOnce([{ userId: 1 }]);

    expect(await getChallengeReminderRecipients(7)).toEqual([1]);
    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
  });
});
