import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261225120000_personal_data_export/migration.sql'
);

/**
 * One build, with every source and the bucket faked: who is emailed, what the row records, and what
 * the notes file holds. The archive's own streaming is `personal-data-export.archive.test.ts`.
 */

const m = vi.hoisted(() => ({
  holds: vi.fn(),
  builtSend: vi.fn(),
  readySend: vi.fn(),
  heldSend: vi.fn(),
  refusedSend: vi.fn(),
  del: vi.fn(),
  put: vi.fn(),
  stream: vi.fn(),
  pg: vi.fn(),
  grant: vi.fn(),
  manifest: null as unknown,
}));

vi.mock('~/server/services/moderator-grants', () => ({ hasModeratorGrant: m.grant }));

vi.mock('~/server/services/legal-hold.service', () => ({
  getAccountLegalHold: m.holds,
  accountHoldSql: () => null,
}));
vi.mock('~/server/email/templates/personalDataExport.email', () => ({
  personalDataExportBuiltEmail: { send: m.builtSend },
  personalDataExportReadyEmail: { send: m.readySend },
  personalDataExportHeldEmail: { send: m.heldSend },
  personalDataExportRefusedEmail: { send: m.refusedSend },
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {},
  pgDbWrite: {},
  pgDbReadLong: { connect: vi.fn() },
}));
vi.mock('../archive', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  putSmallObject: m.put,
  deleteObjects: m.del,
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

import { logToAxiom } from '~/server/logging/client';
import { MAX_ATTEMPTS, buildExport, type ExportRow } from '../personal-data-export.service';

const OWNER_ID = 42;
const STAFF_ID = 9;
const row: ExportRow = {
  id: 5,
  userId: OWNER_ID,
  requestedById: STAFF_ID,
  status: 'building',
  attempts: 1,
  archiveKey: null,
  builtAt: null,
  createdAt: new Date('2026-11-06T12:00:00Z'),
  ticketId: 555,
  // Weeks before it was queued: the email must carry this, not the queue date.
  requestedAt: '2026-09-14',
};
const deps = {
  bucket: {} as never,
  workflows: {} as never,
  clickhouse: {} as never,
  stripe: undefined,
};

type TestUser = {
  id: number;
  username: string;
  email: string;
  customerId: null;
  isModerator: boolean;
  deletedAt: Date | null;
  bannedAt: Date | null;
  roles: { role: string }[];
};
const person = { customerId: null, deletedAt: null, bannedAt: null } as const;
const users: Record<number, TestUser> = {
  [OWNER_ID]: {
    ...person,
    id: OWNER_ID,
    username: 'owner',
    email: 'owner@example.com',
    isModerator: false,
    roles: [],
  },
  [STAFF_ID]: {
    ...person,
    id: STAFF_ID,
    username: 'ModBob',
    email: 'staff@civitai.com',
    isModerator: true,
    roles: [{ role: 'moderator:support' }],
  },
};
const sqlOf = (c: unknown[]) => (c[0] as unknown as string[]).join('?');
const writes = () => vi.mocked(dbMock.dbWrite.$executeRaw).mock.calls;
const ARCHIVE = /^exports\/5\/.+\.zip$/;
const NOTES = /^exports\/5\/.+-internal-notes\.csv$/;
/** The export ids of every alert raised (`alert: true`, what the Axiom monitor matches). */
const alertedIds = () =>
  vi
    .mocked(logToAxiom)
    .mock.calls.map(([e]) => e.details as { alert?: boolean; exportId?: number } | undefined)
    .filter((d) => d?.alert === true)
    .map((d) => d?.exportId);
/** Every object key this build asked the bucket to delete. */
const uploadsDeleted = () =>
  m.del.mock.calls.flatMap(([, keys]) => (keys as (string | null)[]).filter(Boolean));

beforeEach(() => {
  for (const f of [m.holds, m.builtSend, m.readySend, m.heldSend, m.refusedSend, m.del, m.put])
    f.mockReset();
  for (const f of [m.stream, m.pg, m.grant]) f.mockReset();
  vi.mocked(logToAxiom).mockClear();
  m.grant.mockResolvedValue(true);
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
    expect(m.builtSend.mock.calls[0][0]).toMatchObject({ to: 'staff@civitai.com' });
    // An account under no hold: nothing to Legal.
    expect(m.refusedSend).not.toHaveBeenCalled();
    expect(m.heldSend).not.toHaveBeenCalled();
    const recorded = writes().findIndex((c) => sqlOf(c).includes('"archiveKey" ='));
    const sent = writes().findIndex((c) => sqlOf(c).includes('"sentAt" = now()'));
    expect(recorded).toBeGreaterThanOrEqual(0);
    expect(sent).toBeGreaterThan(recorded);
    // Checked at send time, on the requester's own roles.
    expect(m.grant).toHaveBeenCalledWith(
      { roles: ['moderator:support'] },
      'user.personalDataExport.queue'
    );
  });

  it.each([
    ['lost the queue permission', () => m.grant.mockResolvedValue(false)],
    ['is no longer a moderator', () => (users[STAFF_ID].isModerator = false)],
    ['was banned', () => (users[STAFF_ID].bannedAt = new Date())],
  ])(
    'keeps the archive but sends no link when the requester %s, and says so on the row',
    async (_case, revoke) => {
      const saved = { ...users[STAFF_ID] };
      revoke();
      try {
        expect(await buildExport(row, deps)).toBe('built');
        expect(m.builtSend).not.toHaveBeenCalled();
        expect(writes().some((c) => sqlOf(c).includes('"sentAt" = now()'))).toBe(false);
        const noted = writes().find((c) => sqlOf(c).includes('SET error ='));
        expect(String(noted?.[1])).toBe(
          'built; requester email failed: the requester may no longer queue exports'
        );
      } finally {
        users[STAFF_ID] = saved;
      }
    }
  );

  it("keeps a failed link email's error off the row, and puts it in the log", async () => {
    const raw = '550 mailbox staff@civitai.com unavailable at mx.provider.example';
    m.builtSend.mockRejectedValue(new Error(raw));
    expect(await buildExport(row, deps)).toBe('built');
    const noted = writes().find((c) => sqlOf(c).includes('SET error ='));
    expect(String(noted?.[1])).toBe('built; requester email failed');
    expect(
      vi.mocked(logToAxiom).mock.calls.map(([e]) => (e.details as { error?: string })?.error)
    ).toContain(raw);
  });

  /**
   * 🔴 Ruled by Legal and the Moderation Lead: an account under a hold gets NO archive. Nothing is
   * built or uploaded, no link goes to anyone, Legal's intake gets exactly one notice in the format
   * its sweep reads, and the moderator who queued it is told only that it is being routed to Legal. If
   * you are about to build a held account's archive "for Legal to review", this test is why not.
   */
  it('refuses a held account: nothing built, one notice to Legal, the requester told only that', async () => {
    m.holds.mockResolvedValue({ legs: ['report'], markerView: true });
    expect(await buildExport(row, deps)).toBe('held');
    expect(m.stream).not.toHaveBeenCalled();
    expect(m.pg).not.toHaveBeenCalled();
    expect(m.put).not.toHaveBeenCalled();
    expect(m.builtSend).not.toHaveBeenCalled();
    expect(m.readySend).not.toHaveBeenCalled();
    expect(m.refusedSend.mock.calls).toEqual([
      [
        {
          to: 'compliance@civitai.com',
          subject: 'DATA-EXPORT-REFUSED user=42 ticket=555 requested=2026-09-14',
          lines: ['user=42', 'ticket=555', 'requested=2026-09-14'],
        },
      ],
    ]);
    // The notice names the export, never the reason.
    expect(m.heldSend.mock.calls).toEqual([[{ to: 'staff@civitai.com', exportId: 5 }]]);
    const held = writes().find((c) => sqlOf(c).includes(`SET status = 'held'`))!;
    expect(held).toEqual(expect.arrayContaining([['report']]));
  });

  it('says ticket=none for a request queued from the dashboard', async () => {
    m.holds.mockResolvedValue({ legs: ['report'], markerView: true });
    await buildExport({ ...row, ticketId: null }, deps);
    expect(m.refusedSend.mock.calls[0][0]).toMatchObject({
      subject: 'DATA-EXPORT-REFUSED user=42 ticket=none requested=2026-09-14',
      lines: ['user=42', 'ticket=none', 'requested=2026-09-14'],
    });
  });

  it.each([[{ present: true, review: false }], [{ present: false, review: true }]])(
    'refuses every kind of hold the same way (#%#)',
    async (found) => {
      vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (q: unknown) => {
        const text = Array.isArray(q) ? q.join('?') : String((q as { sql?: string }).sql ?? '');
        if (text.includes('"isModerator"')) return [{ id: STAFF_ID, username: 'ModBob' }];
        return [found];
      }) as never);
      expect(await buildExport(row, deps)).toBe('held');
      expect(m.stream).not.toHaveBeenCalled();
      expect(m.refusedSend).toHaveBeenCalledTimes(1);
      expect(m.builtSend).not.toHaveBeenCalled();
    }
  );

  it('deletes the archive when a hold lands while it is being built', async () => {
    m.holds
      .mockResolvedValueOnce({ legs: [], markerView: true })
      .mockResolvedValue({ legs: ['report'], markerView: true });
    expect(await buildExport(row, deps)).toBe('held');
    expect(m.stream).toHaveBeenCalledTimes(1);
    const [, keys] = m.del.mock.calls[0] as [unknown, (string | null)[]];
    expect(keys[0]).toMatch(/^exports\/5\/.+\.zip$/);
    expect(keys[1]).toMatch(/^exports\/5\/.+-internal-notes\.csv$/);
    expect(m.builtSend).not.toHaveBeenCalled();
    expect(m.refusedSend).toHaveBeenCalledTimes(1);
    const held = writes().find((c) => sqlOf(c).includes(`SET status = 'held'`))!;
    expect(sqlOf(held)).toContain('"archiveKey" = NULL');
  });

  it("deletes a held account's upload even when this attempt no longer owns the row", async () => {
    m.holds
      .mockResolvedValueOnce({ legs: [], markerView: true })
      .mockResolvedValue({ legs: ['report'], markerView: true });
    // Recovered as stale while this ran: the refusal's guarded UPDATE matches nothing.
    vi.mocked(dbMock.dbWrite.$executeRaw).mockResolvedValue(0 as never);
    expect(await buildExport(row, deps)).toBe('failed');
    expect(m.del).toHaveBeenCalledTimes(1);
    const [, keys] = m.del.mock.calls[0] as [unknown, (string | null)[]];
    expect(keys[0]).toMatch(/^exports\/5\/.+\.zip$/);
    // The row is another attempt's now: it, not this one, tells Legal.
    expect(m.refusedSend).not.toHaveBeenCalled();
  });

  it('tells the reviewer a skipped source is not included and needs a separate read, apart from a failed one', async () => {
    await buildExport(row, deps);
    const lines = (m.manifest as { lines: string[] }).lines;
    expect(lines.find((l) => l.startsWith('Not included in this archive:'))).toContain(
      'need a separate read'
    );
    expect(lines.some((l) => l.includes('"unavailable" could not be read'))).toBe(true);
    expect(
      lines.some((l) => l.startsWith('leftOut') && l.includes('could not be reliably attributed'))
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

  it('retries, rather than holds, when the hold check itself could not be read', async () => {
    m.holds.mockRejectedValue(new Error('primary down'));
    expect(await buildExport(row, deps)).toBe('queued');
    expect(m.builtSend).not.toHaveBeenCalled();
    expect(writes().some((c) => sqlOf(c).includes('"archiveKey" ='))).toBe(false);
  });

  /**
   * The hold is checked again after the upload. If that second check cannot be read, the archive is
   * neither recorded nor refused: the attempt is retried, and what it uploaded is deleted.
   */
  it('retries, recording nothing, when the hold check after the upload could not be read', async () => {
    m.holds
      .mockResolvedValueOnce({ legs: [], markerView: true })
      .mockResolvedValue({ legs: ['unconfirmed'], markerView: true });
    expect(await buildExport(row, deps)).toBe('queued');
    expect(m.stream).toHaveBeenCalledTimes(1);
    expect(m.builtSend).not.toHaveBeenCalled();
    expect(m.refusedSend).not.toHaveBeenCalled();
    expect(m.heldSend).not.toHaveBeenCalled();
    expect(writes().some((c) => sqlOf(c).includes('"archiveKey" ='))).toBe(false);
    expect(uploadsDeleted()).toEqual([
      expect.stringMatching(ARCHIVE),
      expect.stringMatching(NOTES),
    ]);
  });

  it('does not email anyone when the row stopped building while it ran, and deletes its upload', async () => {
    vi.mocked(dbMock.dbWrite.$executeRaw).mockResolvedValue(0 as never);
    expect(await buildExport(row, deps)).toBe('failed');
    expect(m.builtSend).not.toHaveBeenCalled();
    expect(uploadsDeleted()).toEqual([
      expect.stringMatching(ARCHIVE),
      expect.stringMatching(NOTES),
    ]);
  });

  it('treats a Postgres read failing mid-build as a failed attempt: retried, then failed', async () => {
    m.pg.mockRejectedValue(new Error('read died mid-stream'));
    expect(await buildExport(row, deps)).toBe('queued');
    expect(await buildExport({ ...row, attempts: MAX_ATTEMPTS }, deps)).toBe('failed');
    expect(m.builtSend).not.toHaveBeenCalled();
    expect(writes().some((c) => sqlOf(c).includes('"archiveKey" ='))).toBe(false);
    expect(alertedIds()).toEqual([5]);
  });

  // Every path in a build that ends the export failed raises the alert; one attempt short does not.
  it.each([
    [
      'the user no longer exists',
      () => vi.mocked(dbMock.dbWrite.user.findUnique).mockResolvedValue(null),
    ],
    [
      'the first hold check cannot be read',
      () => m.holds.mockResolvedValue({ legs: ['unconfirmed'], markerView: true }),
    ],
    ['the build throws', () => m.stream.mockRejectedValue(new Error('upload failed'))],
    [
      'the hold check after the upload cannot be read',
      () =>
        m.holds
          .mockResolvedValueOnce({ legs: [], markerView: true })
          .mockResolvedValue({ legs: ['unconfirmed'], markerView: true }),
    ],
  ])('raises the failed alert when %s on the last attempt', async (_case, arrange) => {
    arrange();
    expect(await buildExport({ ...row, attempts: MAX_ATTEMPTS }, deps)).toBe('failed');
    expect(alertedIds()).toEqual([5]);
  });

  it('raises no alert for an attempt that will be retried (control)', async () => {
    m.stream.mockRejectedValue(new Error('upload failed'));
    expect(await buildExport({ ...row, attempts: 1 }, deps)).toBe('queued');
    expect(alertedIds()).toEqual([]);
  });

  it('deletes a completed archive when the build fails after uploading it', async () => {
    m.put.mockRejectedValue(new Error('notes upload failed'));
    expect(await buildExport(row, deps)).toBe('queued');
    expect(m.builtSend).not.toHaveBeenCalled();
    expect(uploadsDeleted()).toEqual([
      expect.stringMatching(ARCHIVE),
      expect.stringMatching(NOTES),
    ]);
  });

  it('goes back to queued after a failed attempt, and to failed after the last', async () => {
    m.stream.mockRejectedValue(new Error('upload failed'));
    expect(await buildExport(row, deps)).toBe('queued');
    expect(await buildExport({ ...row, attempts: MAX_ATTEMPTS }, deps)).toBe('failed');
    expect(m.builtSend).not.toHaveBeenCalled();
    expect(writes().some((c) => sqlOf(c).includes('"archiveKey" ='))).toBe(false);
    // The upload itself failed (and tore itself down): nothing of this attempt is in the bucket.
    expect(uploadsDeleted()).toEqual([]);
  });
});

describe('buildExport record, run', () => {
  // The record UPDATE runs against Postgres with the real migration, so its casts are checked.
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    // Both migrations, in the order they are applied.
    for (const f of [
      MIGRATION,
      MIGRATION.replace(
        '20261225120000_personal_data_export',
        '20261228120000_personal_data_export_request'
      ),
    ])
      await db.exec(readFileSync(f, 'utf8'));
  });
  afterAll(() => db?.close());

  beforeEach(async () => {
    await db.exec(`DELETE FROM "PersonalDataExport"`);
    await db.query(
      `INSERT INTO "PersonalDataExport" (id, "userId", "requestedById", status, attempts)
       VALUES ($1, $2, $3, 'building', $4)`,
      [row.id, OWNER_ID, STAFF_ID, row.attempts]
    );
    vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const q = Prisma.sql(strings, ...values);
      return (await db.query(q.text, q.values as unknown[])).affectedRows ?? 0;
    }) as never);
  });

  const stored = async () =>
    (
      await db.query<{
        status: string;
        archiveKey: string | null;
        holdReasons: string[];
        manifest: { files: unknown[]; internalNotes: number } | null;
        builtAt: Date | null;
      }>(
        `SELECT status, "archiveKey", "holdReasons", manifest, "builtAt"
           FROM "PersonalDataExport" WHERE id = $1`,
        [row.id]
      )
    ).rows[0];

  it('records a built archive with its manifest and no hold reasons', async () => {
    expect(await buildExport(row, deps)).toBe('built');
    const r = await stored();
    expect(r.status).toBe('built');
    expect(r.archiveKey).toMatch(/^exports\/5\/.+\.zip$/);
    expect(r.holdReasons).toEqual([]);
    expect(r.manifest).toMatchObject({ internalNotes: 1 });
    expect(r.manifest?.files.length).toBeGreaterThan(0);
    expect(r.builtAt).toBeInstanceOf(Date);
  });

  it('records nothing over a later attempt: a run recovered as stale leaves the row as it is', async () => {
    await db.exec(`UPDATE "PersonalDataExport" SET attempts = 2 WHERE id = ${row.id}`);
    const before = await stored();
    expect(await buildExport({ ...row, attempts: 1 }, deps)).toBe('failed');
    expect(await stored()).toEqual(before);
    expect(m.builtSend).not.toHaveBeenCalled();
  });

  it('deletes the upload and keeps the row when the Legal notice fails, and records it as owed', async () => {
    m.holds
      .mockResolvedValueOnce({ legs: [], markerView: true })
      .mockResolvedValue({ legs: ['report'], markerView: true });
    m.refusedSend.mockRejectedValue(new Error('smtp down'));
    expect(await buildExport(row, deps)).toBe('held');
    expect(uploadsDeleted()).toEqual([
      expect.stringMatching(ARCHIVE),
      expect.stringMatching(NOTES),
    ]);
    const { rows } = await db.query<{ status: string; archiveKey: string | null; error: string }>(
      `SELECT status, "archiveKey", error FROM "PersonalDataExport" WHERE id = $1`,
      [row.id]
    );
    expect(rows).toEqual([{ status: 'held', archiveKey: null, error: 'legal notice failed (1)' }]);
    expect(m.heldSend).toHaveBeenCalledTimes(1);
  });

  it('records a refused held export with its hold reasons and no archive', async () => {
    m.holds.mockResolvedValue({ legs: ['report'], markerView: true });
    expect(await buildExport(row, deps)).toBe('held');
    const r = await stored();
    expect(r.status).toBe('held');
    expect(r.holdReasons).toEqual(['report']);
    expect(r.archiveKey).toBeNull();
  });
});
