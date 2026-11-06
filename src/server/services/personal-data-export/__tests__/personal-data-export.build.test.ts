import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * One build, with every source and the bucket faked: who is emailed, what the row records, and what
 * the notes file holds. The archive's own streaming is `personal-data-export.archive.test.ts`.
 */

const m = vi.hoisted(() => ({
  holds: vi.fn(),
  builtSend: vi.fn(),
  readySend: vi.fn(),
  put: vi.fn(),
  stream: vi.fn(),
  pg: vi.fn(),
  manifest: null as unknown,
}));

vi.mock('~/server/services/legal-hold.service', () => ({
  getAccountLegalHold: m.holds,
  accountHoldSql: () => null,
}));
vi.mock('~/server/email/templates/personalDataExport.email', () => ({
  personalDataExportBuiltEmail: { send: m.builtSend },
  personalDataExportReadyEmail: { send: m.readySend },
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {},
  pgDbWrite: {},
  pgDbReadLong: { connect: vi.fn() },
}));
vi.mock('../archive', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  putSmallObject: m.put,
  presignDownload: async (_b: unknown, key: string) => ({
    url: `https://bucket/${key}`,
    expiresAt: new Date('2026-11-08T00:00:00Z'),
  }),
  streamArchiveToBucket: async (_b: unknown, _k: string, build: (w: unknown) => Promise<void>) => {
    await m.stream();
    await build({
      addFile: async (name: string, content: unknown) => {
        if (name === 'manifest.json') m.manifest = JSON.parse(content as string);
      },
    });
  },
}));
vi.mock('../sources/postgres', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exportPostgres: m.pg,
}));
vi.mock('../sources/clickhouse', () => ({
  exportClickhouse: async () => ({ files: [], counts: [] }),
}));
vi.mock('../sources/mongo', () => ({
  exportWorkflows: async () => ({
    file: 'w',
    source: 'mongo',
    rows: 0,
    description: '',
    status: 'complete',
  }),
}));
vi.mock('../sources/stripe', () => ({ exportStripe: async () => [] }));

import { MAX_ATTEMPTS, buildExport, type ExportRow } from '../personal-data-export.service';

const OWNER_ID = 42;
const STAFF_ID = 9;
const row: ExportRow = {
  id: 5,
  userId: OWNER_ID,
  requestedById: STAFF_ID,
  status: 'building',
  modNotesMode: 'text-redacted-separate-file',
  attempts: 1,
  archiveKey: null,
  builtAt: null,
};
const deps = {
  bucket: {} as never,
  workflows: {} as never,
  clickhouse: {} as never,
  stripe: undefined,
};

const users: Record<number, { id: number; username: string; email: string; customerId: null }> = {
  [OWNER_ID]: { id: OWNER_ID, username: 'owner', email: 'owner@example.com', customerId: null },
  [STAFF_ID]: { id: STAFF_ID, username: 'ModBob', email: 'staff@civitai.com', customerId: null },
};
const sqlOf = (c: unknown[]) => (c[0] as unknown as string[]).join('?');
const writes = () => vi.mocked(dbMock.dbWrite.$executeRaw).mock.calls;

beforeEach(() => {
  for (const f of [m.holds, m.builtSend, m.readySend, m.put, m.stream, m.pg]) f.mockReset();
  m.manifest = null;
  m.holds.mockResolvedValue({ legs: [], markerView: true });
  m.pg.mockImplementation(async ({ onNote }: { onNote: (n: unknown) => void }) => {
    onNote({
      table: 'Appeal',
      column: 'internalNotes',
      rowId: 1,
      createdAt: null,
      text: 'ModBob (user 9) checked',
    });
    return {
      files: [{ file: 'data/postgres/Appeal.csv', rows: 1, status: 'complete' }],
      noteCount: 1,
    };
  });
  vi.mocked(dbMock.dbWrite.user.findUnique).mockImplementation(
    (async (args: { where: { id: number } }) => users[args.where.id] ?? null) as never
  );
  vi.mocked(dbMock.dbWrite.$executeRaw)
    .mockReset()
    .mockResolvedValue(1 as never);
  vi.mocked(dbMock.dbWrite.$queryRaw)
    .mockReset()
    .mockImplementation((async (q: { sql?: string } | string[]) => {
      const text = Array.isArray(q) ? q.join('?') : String((q as { sql?: string }).sql ?? '');
      if (text.includes('"isModerator"')) return [{ id: STAFF_ID, username: 'ModBob' }];
      return [{ present: false, review: false }];
    }) as never);
});

describe('buildExport', () => {
  it('emails the staff member who queued it, never the owner, and records the archive first', async () => {
    expect(await buildExport(row, deps)).toBe('built');
    expect(m.readySend).not.toHaveBeenCalled();
    expect(m.builtSend).toHaveBeenCalledTimes(1);
    expect(m.builtSend.mock.calls[0][0]).toMatchObject({ to: 'staff@civitai.com', held: false });
    const recorded = writes().findIndex((c) => sqlOf(c).includes('"archiveKey" ='));
    const sent = writes().findIndex((c) => sqlOf(c).includes('"sentAt" = now()'));
    expect(recorded).toBeGreaterThanOrEqual(0);
    // Pinned to this attempt, so a run recovered as stale cannot record over a later attempt.
    const record = writes()[recorded];
    expect(sqlOf(record)).toMatch(/AND attempts = \?\s*$/);
    expect(record[record.length - 1]).toBe(row.attempts);
    expect(sent).toBeGreaterThan(recorded);
  });

  it('marks a held account held, and says so to the staff member', async () => {
    m.holds.mockResolvedValue({ legs: ['report'], markerView: true });
    expect(await buildExport(row, deps)).toBe('held');
    expect(m.builtSend.mock.calls[0][0]).toMatchObject({ held: true });
    expect(m.readySend).not.toHaveBeenCalled();
  });

  it('marks an account held when a decided case puts it under a hold', async () => {
    vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (q: unknown) => {
      const text = Array.isArray(q) ? q.join('?') : String((q as { sql?: string }).sql ?? '');
      if (text.includes('"isModerator"')) return [{ id: STAFF_ID, username: 'ModBob' }];
      return [{ present: false, review: true }];
    }) as never);
    expect(await buildExport(row, deps)).toBe('held');
    expect(m.builtSend.mock.calls[0][0]).toMatchObject({ held: true });
    expect(
      writes().some((c) => c.slice(1).some((v) => Array.isArray(v) && v.includes('review')))
    ).toBe(true);
  });

  it('writes the notes file with staff redacted, and never puts a note count in the archive', async () => {
    await buildExport(row, deps);
    expect(m.put).toHaveBeenCalledTimes(1);
    const body = m.put.mock.calls[0][2] as string;
    expect(body).toContain('[staff] (user [staff]) checked');
    expect(body).not.toContain('ModBob');
    expect(m.manifest).toMatchObject({ files: expect.arrayContaining([expect.anything()]) });
    expect(JSON.stringify(m.manifest)).not.toMatch(/internalNotes|Legal review|"count"/);
  });

  /**
   * 🔴 Required by Legal: a held account must look exactly like any other export in progress from
   * the user's side. The account owner is never sent anything by a build, held or not, and the
   * archive's manifest is the same document whether or not the account is held. Whatever differs
   * (status, the staff email's wording) is staff-only. If you are about to make a build tell the
   * owner anything, this test is why not.
   */
  it('builds a held account exactly like a clean one, as far as the owner can see', async () => {
    const manifests: unknown[] = [];
    for (const legs of [[], ['report'], ['safety-content']]) {
      m.holds.mockResolvedValue({
        legs: legs.filter((l) => l !== 'safety-content'),
        markerView: true,
      });
      vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (q: unknown) => {
        const text = Array.isArray(q) ? q.join('?') : String((q as { sql?: string }).sql ?? '');
        if (text.includes('"isModerator"')) return [{ id: STAFF_ID, username: 'ModBob' }];
        return [{ present: legs.includes('safety-content'), review: false }];
      }) as never);
      await buildExport(row, deps);
      expect(m.manifest).toMatchObject({ files: expect.arrayContaining([expect.anything()]) });
      manifests.push({ ...(m.manifest as Record<string, unknown>), generatedAt: 'T' });
      m.manifest = null;
    }
    expect(m.readySend).not.toHaveBeenCalled();
    // Every build email went to the staff member, none to the owner.
    expect(m.builtSend.mock.calls.map((c) => c[0].to)).toEqual([
      'staff@civitai.com',
      'staff@civitai.com',
      'staff@civitai.com',
    ]);
    expect(m.builtSend.mock.calls.map((c) => c[0].held)).toEqual([false, true, true]);
    expect(manifests[1]).toEqual(manifests[0]);
    expect(manifests[2]).toEqual(manifests[0]);
  });

  it('retries, rather than holds, when the hold check itself could not be read', async () => {
    m.holds.mockRejectedValue(new Error('primary down'));
    expect(await buildExport(row, deps)).toBe('queued');
    expect(m.builtSend).not.toHaveBeenCalled();
    expect(writes().some((c) => sqlOf(c).includes('"archiveKey" ='))).toBe(false);
  });

  it('writes no notes file in count mode', async () => {
    await buildExport({ ...row, modNotesMode: 'count' }, deps);
    expect(m.put).not.toHaveBeenCalled();
  });

  it('does not email anyone when the row stopped building while it ran', async () => {
    vi.mocked(dbMock.dbWrite.$executeRaw).mockResolvedValue(0 as never);
    expect(await buildExport(row, deps)).toBe('failed');
    expect(m.builtSend).not.toHaveBeenCalled();
  });

  it('goes back to queued after a failed attempt, and to failed after the last', async () => {
    m.stream.mockRejectedValue(new Error('upload failed'));
    expect(await buildExport(row, deps)).toBe('queued');
    expect(await buildExport({ ...row, attempts: MAX_ATTEMPTS }, deps)).toBe('failed');
    expect(m.builtSend).not.toHaveBeenCalled();
    expect(writes().some((c) => sqlOf(c).includes('"archiveKey" ='))).toBe(false);
  });
});
