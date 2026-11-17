import { S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ArchiveModule from '../archive';

const mocks = vi.hoisted(() => ({
  holds: vi.fn(),
  holdSqlArgs: vi.fn(),
  readySend: vi.fn(),
  builtSend: vi.fn(),
  refusedSend: vi.fn(),
  heldSend: vi.fn(),
  del: vi.fn(),
}));
vi.mock('../archive', async (importOriginal) => ({
  ...(await importOriginal<typeof ArchiveModule>()),
  deleteObjects: mocks.del,
}));

vi.mock('~/server/services/legal-hold.service', async () => {
  const { Prisma } = await import('@prisma/client');
  return {
    getAccountLegalHold: mocks.holds,
    // A marker the claim test can find: the claim must carry the hold condition in its own WHERE.
    accountHoldSql: (id: unknown, markerView: unknown) => {
      mocks.holdSqlArgs(id, markerView);
      return Prisma.sql`HOLD_CONDITION(${id})`;
    },
  };
});
vi.mock('~/server/email/templates/personalDataExport.email', () => ({
  personalDataExportReadyEmail: { send: mocks.readySend },
  personalDataExportBuiltEmail: { send: mocks.builtSend },
  personalDataExportRefusedEmail: { send: mocks.refusedSend },
  personalDataExportHeldEmail: { send: mocks.heldSend },
}));

import { RELEASE_WINDOW_SECONDS, exportObjectKey, presignDownload } from '../archive';
import { exportRecipient, releaseExport } from '../personal-data-export.service';

const bucket = {
  client: new S3Client({
    region: 'us-west-004',
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  }),
  Bucket: 'exports-test',
};

const OWNER = { email: 'owner@example.com', username: 'owner', deletedAt: null };
const builtAt = new Date('2026-11-06T00:00:00Z');
const now = new Date('2026-11-07T00:00:00Z');
const built = { id: 5, userId: 42, status: 'built', archiveKey: 'exports/5/k.zip', builtAt };

/** The SQL of every raw write, so a test can tell which status change ran. */
const writes = () =>
  vi
    .mocked(dbMock.dbWrite.$executeRaw)
    .mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.holds.mockResolvedValue({ legs: [], markerView: true });
  mocks.readySend.mockResolvedValue(undefined);
  vi.mocked(dbMock.dbWrite.personalDataExport.findUnique).mockResolvedValue(built as never);
  vi.mocked(dbMock.dbWrite.user.findUnique).mockResolvedValue(OWNER as never);
  vi.mocked(dbMock.dbWrite.$executeRaw)
    .mockReset()
    .mockResolvedValue(1 as never);
  // No hold.
  vi.mocked(dbMock.dbWrite.$queryRaw)
    .mockReset()
    .mockResolvedValue([{ present: false, review: false }] as never);
});

/** The claim UPDATE: its SQL and the values bound into it. */
const claimCall = () =>
  vi
    .mocked(dbMock.dbWrite.$executeRaw)
    .mock.calls.find((c) =>
      (c[0] as unknown as string[]).join('?').includes(`SET status = 'released'`)
    );

describe('releaseExport', () => {
  it('sends the owner the archive link only, never the internal notes file', async () => {
    vi.mocked(dbMock.dbWrite.personalDataExport.findUnique).mockResolvedValue({
      ...built,
      modNotesKey: 'exports/5/n-internal-notes.csv',
    } as never);
    await releaseExport({ exportId: 5, actorId: 9, bucket, now });
    expect(mocks.readySend).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(mocks.readySend.mock.calls[0][0]);
    expect(sent).toContain('exports/5/k.zip');
    expect(sent).not.toContain('internal-notes');
    // A release that sends never even reads which notes object an export has.
    expect(dbMock.dbWrite.personalDataExport.findUnique).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.personalDataExport.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.not.objectContaining({ modNotesKey: true }) })
    );
  });

  it("sends the cover note to the owner's registered email with a 48-hour link", async () => {
    const result = await releaseExport({ exportId: 5, actorId: 9, bucket, now });
    expect(result).toMatchObject({ ok: true, userId: 42 });
    expect(mocks.readySend).toHaveBeenCalledTimes(1);
    const sent = mocks.readySend.mock.calls[0][0];
    expect(sent.to).toBe('owner@example.com');
    expect(sent.link).toContain('X-Amz-Expires=172800');
    expect(sent.link).toContain('exports/5/k.zip');
    // Downloads under a fixed name, never the random object key.
    expect(decodeURIComponent(sent.link)).toContain('attachment; filename="civitai-data.zip"');
    // Every lookup is of this export and its owner, never the acting moderator.
    expect(dbMock.dbWrite.personalDataExport.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5 } })
    );
    expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42 } })
    );
    expect(mocks.holds).toHaveBeenCalledWith(42);
    // The claim records who released it, only from built, and re-checks the hold in the same statement.
    const claim = claimCall()!;
    const sql = (claim[0] as unknown as string[]).join('?');
    expect(sql).toContain(`AND status = 'built'`);
    expect(claim.slice(1)).toEqual(expect.arrayContaining([now, 9, 5]));
    const strings = claim[0] as unknown as string[];
    const at = strings.findIndex((part) => part.trimEnd().endsWith('"releasedById" ='));
    expect(claim[at + 1]).toBe(9);
  });

  it.each([false, true])(
    "re-checks the owner's holds in the claim, never the actor's (markerView %s)",
    async (markerView) => {
      mocks.holds.mockResolvedValue({ legs: [], markerView });
      expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toMatchObject({
        ok: true,
      });
      expect(mocks.holdSqlArgs).toHaveBeenCalledTimes(1);
      const [id, view] = mocks.holdSqlArgs.mock.calls[0] as [{ values: unknown[] }, boolean];
      expect(id.values).toEqual([42]);
      expect(view).toBe(markerView);
      // Every other fragment of the claim is over the owner too.
      const fragments = claimCall()!
        .slice(1)
        .filter((v): v is { strings: string[]; values: unknown[] } =>
          Boolean(v && typeof v === 'object' && 'strings' in v)
        );
      const caseHold = fragments.find((f) => f.strings.join('?').includes('"UserReport"'));
      expect(caseHold?.values).toEqual([42]);
    }
  );

  it.each([[{ present: true, review: false }], [{ present: false, review: true }]])(
    'refuses when the account is under a hold (#%#)',
    async (found) => {
      vi.mocked(dbMock.dbWrite.$queryRaw).mockResolvedValue([found] as never);
      expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toEqual({
        ok: false,
        reason: 'held',
      });
      expect(mocks.readySend).not.toHaveBeenCalled();
    }
  );

  it('keeps the export released when only the expiry write fails after sending', async () => {
    vi.mocked(dbMock.dbWrite.$executeRaw)
      .mockResolvedValueOnce(1 as never) // the claim
      .mockRejectedValueOnce(new Error('db blip') as never); // linkExpiresAt
    const result = await releaseExport({ exportId: 5, actorId: 9, bucket, now });
    expect(result).toMatchObject({ ok: true });
    expect(writes().some((w) => w.includes(`SET status = 'built'`))).toBe(false);
  });

  it('refuses and sends nothing when a hold applies, and marks the export held', async () => {
    mocks.holds.mockResolvedValue({ legs: ['report'], markerView: true });
    const result = await releaseExport({ exportId: 5, actorId: 9, bucket, now });
    expect(result).toEqual({ ok: false, reason: 'held' });
    expect(mocks.readySend).not.toHaveBeenCalled();
    expect(writes().some((w) => w.includes(`SET status = 'held'`))).toBe(true);
    expect(writes().some((w) => w.includes(`SET status = 'released'`))).toBe(false);
    expect(mocks.refusedSend).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledTimes(1);
  });

  it('refuses, writing nothing, when the hold check cannot be read, so it can be pressed again', async () => {
    mocks.holds.mockRejectedValue(new Error('db down'));
    const result = await releaseExport({ exportId: 5, actorId: 9, bucket, now });
    expect(result).toEqual({ ok: false, reason: 'unconfirmed' });
    expect(mocks.readySend).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('refuses a failed export: nothing is sent and nothing is written', async () => {
    vi.mocked(dbMock.dbWrite.personalDataExport.findUnique).mockResolvedValue({
      ...built,
      status: 'failed',
    } as never);
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toEqual({
      ok: false,
      reason: 'not-releasable',
    });
    expect(mocks.readySend).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('refuses an export that is already held, even once its hold has ended', async () => {
    vi.mocked(dbMock.dbWrite.personalDataExport.findUnique).mockResolvedValue({
      ...built,
      status: 'held',
    } as never);
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toEqual({
      ok: false,
      reason: 'not-releasable',
    });
    expect(mocks.readySend).not.toHaveBeenCalled();
  });

  it('refuses when the account has no email, or was deleted', async () => {
    vi.mocked(dbMock.dbWrite.user.findUnique).mockResolvedValue({ ...OWNER, email: null } as never);
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toEqual({
      ok: false,
      reason: 'no-email',
    });
    vi.mocked(dbMock.dbWrite.user.findUnique).mockResolvedValue({
      ...OWNER,
      deletedAt: new Date(),
    } as never);
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toEqual({
      ok: false,
      reason: 'no-email',
    });
    expect(mocks.readySend).not.toHaveBeenCalled();
  });

  it('refuses once the archive is too close to deletion for a full 48-hour link', async () => {
    const late = new Date(builtAt.getTime() + RELEASE_WINDOW_SECONDS * 1000 + 1000);
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now: late })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  /**
   * 🔴 The bucket hides an archive 6 days after it is written (B2: hide at 6, delete 1 day after),
   * and a hidden archive cannot be downloaded. So a 48-hour link must end by day 6, and release
   * closes on day 4. Written in days, not in the constants, so a change to either side shows here.
   */
  it('closes release on day 4, so every 48-hour link ends before the archive is hidden on day 6', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const hiddenAt = builtAt.getTime() + 6 * DAY;
    const lastPress = new Date(builtAt.getTime() + 4 * DAY);
    vi.useFakeTimers({ now: lastPress, toFake: ['Date'] });
    try {
      const result = await releaseExport({ exportId: 5, actorId: 9, bucket, now: lastPress });
      expect(result).toMatchObject({ ok: true });
      const { expiresAt } = result as { expiresAt: Date };
      expect(expiresAt.getTime() - lastPress.getTime()).toBe(2 * DAY);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(hiddenAt);
    } finally {
      vi.useRealTimers();
    }
    const tooLate = new Date(lastPress.getTime() + 1000);
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now: tooLate })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('sends nothing when another press claimed the release first', async () => {
    vi.mocked(dbMock.dbWrite.$executeRaw).mockResolvedValue(0 as never);
    expect(await releaseExport({ exportId: 5, actorId: 9, bucket, now })).toEqual({
      ok: false,
      reason: 'not-releasable',
    });
    expect(mocks.readySend).not.toHaveBeenCalled();
  });

  it('puts the export back to built when the email fails', async () => {
    mocks.readySend.mockRejectedValue(new Error('smtp'));
    await expect(releaseExport({ exportId: 5, actorId: 9, bucket, now })).rejects.toThrow('smtp');
    expect(writes().some((w) => w.includes(`SET status = 'built'`))).toBe(true);
  });
});

describe('exportRecipient', () => {
  const people = {
    requester: { email: 'staff@civitai.com' },
    owner: { email: 'owner@example.com' },
  };
  it('sends a build to the staff member who queued it and a release to the owner, never crossed', () => {
    expect(exportRecipient('built', people)).toBe('staff@civitai.com');
    expect(exportRecipient('release', people)).toBe('owner@example.com');
    expect(exportRecipient('release', { ...people, owner: { email: '  ' } })).toBeNull();
  });
});

describe('export objects', () => {
  it('keys every object under its export id, fresh per attempt', () => {
    const a = exportObjectKey(5, 'archive');
    const b = exportObjectKey(5, 'archive');
    expect(a).toMatch(/^exports\/5\/[0-9a-f-]{36}\.zip$/);
    expect(a).not.toBe(b);
    expect(exportObjectKey(5, 'notes')).toMatch(/^exports\/5\/.+-internal-notes\.csv$/);
  });

  it('signs a link that expires in 48 hours, on the bucket endpoint', async () => {
    const { url, expiresAt } = await presignDownload(bucket, 'exports/5/k.zip', 'data.zip');
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('172800');
    expect(new URL(url).host).toContain('backblazeb2.com');
    expect(Math.abs(expiresAt.getTime() - Date.now() - 172_800_000)).toBeLessThan(5_000);
  });
});
