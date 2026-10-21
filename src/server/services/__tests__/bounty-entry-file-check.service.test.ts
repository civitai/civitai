import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as FileCheck from '~/server/services/bounty-entry-file-check.service';

const { mockFindHashOwnership, mockCheckOn } = vi.hoisted(() => ({
  mockFindHashOwnership: vi.fn(),
  mockCheckOn: vi.fn(async () => true),
}));

vi.mock('~/server/services/model-file-hash-owner.service', () => ({
  findHashOwnership: mockFindHashOwnership,
}));
vi.mock('~/server/services/bounty-entry-file-check.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FileCheck>()),
  isBountyEntryFileCheckOn: mockCheckOn,
}));

import {
  checkPendingBountyEntryFiles,
  fileCheckState,
  getBountyEntryFileStates,
  HASH_FAIL_COUNT_SQL,
} from '~/server/services/bounty-entry-file-check.service';
import {
  awardBountyEntry,
  getBountyEntryFilteredFiles,
} from '~/server/services/bountyEntry.service';

/**
 * Bounty entry files of model bounties are hashed by a job and refused at award, and withheld
 * from download, when they are another user's model.
 */

const AUTHOR = 2;
const SUPPORTER = 3;
const ENTRY_ID = 20;
const BOUNTY_ID = 10;
const SHA = 'F'.repeat(64);

const CLEAN = { hashCheckedAt: '2026-10-20T00:00:00Z', sha256Server: SHA };
const BLOCKED = { ...CLEAN, blockedReason: 'other-users-model' };
const CLEARED = {
  ...BLOCKED,
  checkOverride: { by: 1, at: '2026-10-21T00:00:00Z', reason: 'their own alt account' },
};
const UNCHECKED = {};

loggingMock.logToAxiom.mockImplementation(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckOn.mockResolvedValue(true);
});

describe('fileCheckState', () => {
  it('a clear lifts the block', () => {
    expect(fileCheckState(CLEARED)).toBe('clean');
  });

  // Metadata written before the clear was server-only can hold anything an entrant sent.
  it.each([
    ['true', true],
    ['a string', 'ok'],
    ['an array', [1]],
    ['an empty object', {}],
    ['a string moderator id', { by: '1', at: 'x', reason: 'r' }],
    ['a fractional moderator id', { by: 1.5, at: 'x', reason: 'r' }],
    ['a zero moderator id', { by: 0, at: 'x', reason: 'r' }],
    ['no time', { by: 1, reason: 'r' }],
    ['a numeric time', { by: 1, at: 1, reason: 'r' }],
    ['no reason', { by: 1, at: 'x' }],
    ['an empty reason', { by: 1, at: 'x', reason: '' }],
    ['a whitespace reason', { by: 1, at: 'x', reason: ' \n\t\v\f\r ' }],
    ['a moderator id past 15 digits', { by: 2 ** 53, at: 'x', reason: 'r' }],
  ])('keeps the block when the stored clear is %s', (_, checkOverride) => {
    expect(fileCheckState({ ...BLOCKED, checkOverride })).toBe('blocked');
  });

  // The SQL twin can't see Unicode spaces, so neither does this: both call these reasons present.
  it.each([
    ['a no-break space', ' '],
    ['a byte order mark', '﻿'],
    ['an ideographic space', '　'],
  ])('counts a reason of only %s as a reason, as the SQL does', (_, reason) => {
    expect(fileCheckState({ ...BLOCKED, checkOverride: { by: 1, at: 'x', reason } })).toBe('clean');
  });

  it('takes a 15-digit moderator id', () => {
    expect(
      fileCheckState({
        ...BLOCKED,
        checkOverride: { by: 999_999_999_999_999, at: 'x', reason: 'r' },
      })
    ).toBe('clean');
  });
});

describe('checkPendingBountyEntryFiles', () => {
  const pending = (
    ...files: { id: number; sizeKB?: number; authorId?: number | null; hashFailCount?: number }[]
  ) =>
    dbMock.dbRead.$queryRaw.mockResolvedValue(
      files.map((f) => ({
        name: `file-${f.id}.safetensors`,
        url: `https://storage.example.com/u/${f.id}`,
        sizeKB: 1024,
        authorId: AUTHOR,
        hashFailCount: 0,
        ...f,
      }))
    );

  /** The metadata patch written for each file, keyed by file id. */
  function writes() {
    return new Map(
      dbMock.dbWrite.$executeRaw.mock.calls.map((call: unknown[]) => {
        const values = call.slice(1);
        const patch = JSON.parse(
          values.find((v) => typeof v === 'string' && v.startsWith('{')) as string
        );
        return [values.find((v) => typeof v === 'number') as number, patch];
      })
    );
  }

  it("blocks a file that is on another user's model, judged against the entry's author", async () => {
    pending({ id: 1 });
    mockFindHashOwnership.mockResolvedValue([{ hash: SHA, ownedByOther: true }]);

    const result = await checkPendingBountyEntryFiles({ hashFile: async () => SHA });

    expect(mockFindHashOwnership).toHaveBeenCalledWith({ hashes: [SHA], userId: AUTHOR });
    expect(writes().get(1)).toMatchObject({
      sha256Server: SHA,
      hashCheckedAt: expect.any(String),
      blockedReason: 'other-users-model',
    });
    expect(result).toMatchObject({ checked: 1, blocked: 1, failed: 0 });
  });

  it("clears a file only on the author's own models, or on no model", async () => {
    pending({ id: 1 }, { id: 2 });
    mockFindHashOwnership
      .mockResolvedValueOnce([{ hash: SHA, ownedByOther: false }])
      .mockResolvedValueOnce([]);

    await checkPendingBountyEntryFiles({ hashFile: async () => SHA });

    for (const id of [1, 2]) {
      expect(writes().get(id)).toMatchObject({ hashCheckedAt: expect.any(String) });
      expect(writes().get(id)).not.toHaveProperty('blockedReason');
    }
  });

  it('leaves a file it could not hash unchecked, so award keeps refusing it', async () => {
    pending({ id: 1 });

    const result = await checkPendingBountyEntryFiles({
      hashFile: async () => {
        throw new Error('download failed: 503');
      },
    });

    expect(writes().get(1)).toEqual({
      hashAttemptedAt: expect.any(String),
      hashFailCount: 1,
      hashLastError: 'download failed: 503',
    });
    expect(mockFindHashOwnership).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 0, failed: 1 });
  });

  it('reads a stored failure count only when it is a small whole number', async () => {
    pending({ id: 1 });
    await checkPendingBountyEntryFiles({ hashFile: async () => SHA });

    // A bare `::int` cast throws on a planted string and would fail every run of the job.
    const [strings, ...values] = dbMock.dbRead.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const at = values.indexOf(HASH_FAIL_COUNT_SQL);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(strings[at + 1]).toMatch(/^\s*AS "hashFailCount"/);
    expect(HASH_FAIL_COUNT_SQL.sql.replace(/\s+/g, ' ')).toBe(
      `CASE WHEN jsonb_typeof(f.metadata->'hashFailCount') = 'number' AND (f.metadata->>'hashFailCount') ~ '^[0-9]{1,6}$' THEN (f.metadata->>'hashFailCount')::int ELSE 0 END`
    );
  });

  it('counts repeated failures, and keeps urls out of the recorded error', async () => {
    pending({ id: 1, hashFailCount: 2 });

    await checkPendingBountyEntryFiles({
      hashFile: async () => {
        throw new Error('fetch https://cdn.example.com/f?token=s3cr3t failed: timeout');
      },
    });

    expect(writes().get(1)).toMatchObject({
      hashFailCount: 3,
      hashLastError: 'fetch <url> failed: timeout',
    });
  });

  it('an entry with no author blocks any match', async () => {
    pending({ id: 1, authorId: null });
    mockFindHashOwnership.mockResolvedValue([]);

    await checkPendingBountyEntryFiles({ hashFile: async () => SHA });

    expect(mockFindHashOwnership).toHaveBeenCalledWith({ hashes: [SHA], userId: -1 });
  });

  it('stops at the byte budget, but always takes the first file', async () => {
    pending({ id: 1, sizeKB: 5 * 1024 }, { id: 2, sizeKB: 1 });
    mockFindHashOwnership.mockResolvedValue([]);
    const hashFile = vi.fn(async () => SHA);

    await checkPendingBountyEntryFiles({ hashFile, maxBytes: 1024 });

    expect(hashFile).toHaveBeenCalledTimes(1);
    expect([...writes().keys()]).toEqual([1]);
  });
});

describe('awardBountyEntry', () => {
  function entryWithFiles(type: string, ...metadata: object[]) {
    dbMock.dbWrite.bountyEntry.findUniqueOrThrow.mockResolvedValue({
      id: ENTRY_ID,
      bountyId: BOUNTY_ID,
      userId: AUTHOR,
    });
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { userId: 1, complete: false, refunded: false, poi: false, availability: 'Public', meta: {} },
    ] as never);
    dbMock.dbWrite.bounty.findUnique.mockResolvedValue({ type });
    dbMock.dbWrite.file.findMany.mockResolvedValue(metadata.map((m) => ({ metadata: m })));
    // Past the gate, the award stops at the next check.
    dbMock.dbWrite.bountyBenefactor.findUniqueOrThrow.mockResolvedValue({ awardedToId: 999 });
  }
  const award = () => awardBountyEntry({ id: ENTRY_ID, userId: SUPPORTER });
  const PAST_THE_GATE = 'Supporters have already awarded an entry.';

  it("refuses an entry whose file is another user's model", async () => {
    entryWithFiles('LoraCreation', CLEAN, BLOCKED);
    await expect(award()).rejects.toThrow(
      "This entry's files match a model that belongs to another user and can't be awarded."
    );
    expect(dbMock.dbWrite.bountyBenefactor.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('awards an entry whose blocked file a moderator cleared', async () => {
    entryWithFiles('LoraCreation', CLEAN, CLEARED);
    await expect(award()).rejects.toThrow(PAST_THE_GATE);
  });

  it('refuses an entry with a file not checked yet', async () => {
    entryWithFiles('ModelCreation', CLEAN, UNCHECKED);
    await expect(award()).rejects.toThrow(
      "This entry's files are still being checked. Try again in a few minutes."
    );
  });

  it('control: an entry whose files are all checked and clean goes on to the award', async () => {
    entryWithFiles('EmbedCreation', CLEAN, CLEAN);
    await expect(award()).rejects.toThrow(PAST_THE_GATE);
  });

  it('does nothing while the check is off', async () => {
    mockCheckOn.mockResolvedValue(false);
    entryWithFiles('LoraCreation', BLOCKED);
    await expect(award()).rejects.toThrow(PAST_THE_GATE);
  });

  it('does not apply to bounties that are not for models', async () => {
    entryWithFiles('ImageCreation', BLOCKED, UNCHECKED);
    await expect(award()).rejects.toThrow(PAST_THE_GATE);
  });
});

describe('getBountyEntryFilteredFiles', () => {
  function entryFiles() {
    dbMock.dbRead.bountyEntry.findUniqueOrThrow.mockResolvedValue({
      id: ENTRY_ID,
      userId: AUTHOR,
      bountyId: BOUNTY_ID,
    });
    dbMock.dbRead.file.findMany.mockResolvedValue([
      { id: 1, name: 'a', url: 'https://storage.example.com/u/1', sizeKB: 1, metadata: BLOCKED },
      { id: 2, name: 'b', url: 'https://storage.example.com/u/2', sizeKB: 1, metadata: CLEAN },
      { id: 3, name: 'c', url: 'https://storage.example.com/u/3', sizeKB: 1, metadata: UNCHECKED },
    ]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ id: ENTRY_ID, awardedUnitAmount: 0 }]);
  }
  const urls = async (viewer: { userId?: number; isModerator?: boolean }) =>
    (await getBountyEntryFilteredFiles({ id: ENTRY_ID, ...viewer })).map((f) => f.url);

  it.each([
    ['the author', { userId: AUTHOR }],
    ['another user', { userId: SUPPORTER }],
  ])('withholds a blocked file from %s, and serves the rest', async (_, viewer) => {
    entryFiles();
    expect(await urls(viewer)).toEqual([
      null,
      'https://storage.example.com/u/2',
      'https://storage.example.com/u/3',
    ]);
  });

  it('moderators can still fetch a blocked file', async () => {
    entryFiles();
    expect(await urls({ userId: 1, isModerator: true })).toEqual([
      'https://storage.example.com/u/1',
      'https://storage.example.com/u/2',
      'https://storage.example.com/u/3',
    ]);
  });

  it('serves a file a moderator cleared', async () => {
    entryFiles();
    dbMock.dbRead.file.findMany.mockResolvedValue([
      { id: 1, name: 'a', url: 'https://storage.example.com/u/1', sizeKB: 1, metadata: CLEARED },
    ]);
    expect(await urls({ userId: SUPPORTER })).toEqual(['https://storage.example.com/u/1']);
  });

  it('serves a blocked file while the check is off', async () => {
    mockCheckOn.mockResolvedValue(false);
    entryFiles();
    expect((await urls({ userId: AUTHOR }))[0]).toBe('https://storage.example.com/u/1');
  });
});

describe('getBountyEntryFileStates', () => {
  const states = (...files: { entryId: number; metadata: object }[]) =>
    getBountyEntryFileStates({
      tx: {
        bounty: { findUnique: async () => ({ type: 'LoraCreation' }) },
        $queryRaw: async () => files,
      } as never,
      bountyId: BOUNTY_ID,
      checkOn: true,
    });

  it('keeps an entry with a blocked file out of the expiry award, unless a moderator cleared it', async () => {
    expect(
      await states(
        { entryId: 21, metadata: BLOCKED },
        { entryId: 22, metadata: CLEARED },
        { entryId: 23, metadata: CLEAN }
      )
    ).toEqual({ blockedEntryIds: [21], unchecked: false });
  });
});
