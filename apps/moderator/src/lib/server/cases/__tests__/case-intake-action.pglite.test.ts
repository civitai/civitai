import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Kysely } from 'kysely';
import type { PGlite } from '@electric-sql/pglite';
import type { DB } from '@civitai/db-schema/kysely';
import { resolveAccessToken } from '@civitai/db-queries/access-token';
import { processDefinitionSchema } from '@civitai/moderation/process-definition';
import type { CasesDb } from '../cases.db';
import { casesPglite } from './cases-pglite.harness';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

vi.mock('../../redis', () => ({ getSysRedis: () => ({}) }));
const { caseIntake, RECEIPTS_PER_ADDRESS_PER_DAY, receiptCapFromEnv } = await import(
  '../case-intake-action'
);
const { IntakeRefusedError } = await import('../intake');
const { TurnstileRefusedError } = await import('../turnstile');
const { hashAddress } = await import('../send-notice');

const definition = processDefinitionSchema.parse({
  key: 'dmca-notice',
  title: 'DMCA copyright notice',
  mailbox: 'dmca@civitai.com',
  fields: [
    { id: 'urls', label: 'URLs', kind: 'urlList', required: true },
    { id: 'email', label: 'Email', kind: 'email', required: true },
    { id: 'good-faith', label: 'Good faith', kind: 'checkbox', required: true },
    { id: 'minor', label: 'Under 18', kind: 'checkbox' },
  ],
  states: [{ id: 'received', label: 'Received' }],
  initialState: 'received',
  clocks: [{ id: 'target', label: 'T', startsOn: 'receipt', hours: 48 }],
  notices: [
    {
      id: 'receipt',
      recipientRole: 'claimant',
      subject: 'We received your request ({caseRef})',
      body: 'We received your {requestType} on {receivedAt}. Continue: {continueLink}',
    },
  ],
});
const values = {
  urls: ['https://civitai.com/images/7'],
  email: 'A@Example.com',
  'good-faith': true,
};
const input = (over: Record<string, unknown> = {}) => ({
  processKey: 'dmca-notice',
  submissionId: '6f1c2a52-0d55-4d6e-9d1a-3a4b5c6d7e8f',
  values,
  turnstileToken: 'tt',
  ip: '203.0.113.9',
  ...over,
});

let pg: PGlite;
let db: CasesDb;
let mainDb: Kysely<DB>;
let versionId: number;
type SendMail = (m: {
  to: string;
  replyTo: string;
  subject: string;
  text: string;
}) => Promise<{ messageId: string }>;
let send: Mock<SendMail>;
let verify: Mock<(token: string, ip: string) => Promise<{ hostname: string } | void>>;
let mint: { fail?: boolean };
let pending: Promise<unknown>[];
let alerts: string[][];

beforeEach(async () => {
  ({ pg, db } = await casesPglite());
  const d = await pg.query<{ id: number }>(
    "INSERT INTO process_definition (key) VALUES ('dmca-notice') RETURNING id"
  );
  const v = await pg.query<{ id: number }>(
    'INSERT INTO process_definition_version (definition_id, definition, created_by_id) VALUES ($1, $2, 1) RETURNING id',
    [d.rows[0].id, JSON.stringify(definition)]
  );
  versionId = Number(v.rows[0].id);
  const main = await freshPglite();
  await main.exec(`CREATE TABLE "AccessToken" (
    id serial PRIMARY KEY, "resourceType" text NOT NULL, "resourceId" integer NOT NULL,
    "tokenHash" text NOT NULL UNIQUE, "createdById" integer NOT NULL,
    "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" timestamp(3) NOT NULL, "revokedAt" timestamp(3));`);
  mainDb = new Kysely<DB>({ dialect: pgliteDialect(main) });
  send = vi.fn<SendMail>(async () => ({ messageId: 'm-1' }));
  verify = vi.fn(async (_token: string, _ip: string) => ({ hostname: 'civitai.red' }));
  mint = {};
  pending = [];
  alerts = [];
});
const settled = () => Promise.all(pending);

const deps = () => ({
  db,
  mainDb: mint.fail
    ? (new Proxy(mainDb, {
        get: (t, p) =>
          p === 'insertInto'
            ? () => {
                throw new Error('main down');
              }
            : Reflect.get(t, p),
      }) as Kysely<DB>)
    : mainDb,
  definition: async (key: string) => (key === 'dmca-notice' ? { versionId, definition } : null),
  verifyTurnstile: verify,
  rateLimit: () => undefined,
  sendDeps: () => ({
    db,
    send: send as never,
    readBrake: async () => ({ paused: false } as never),
    pauseSends: async () => undefined as never,
    lockdownOk: async () => true,
    alert: async () => undefined,
    from: 'Civitai DMCA <notices@civitai.com>',
    replyTo: 'unused@civitai.com',
    hourlyCeiling: 400,
  }),
  appUrl: 'https://civitai.example',
  systemUserId: -1,
  log: () => undefined,
  background: (p: Promise<unknown>) => void pending.push(p),
  alert: async (subject: string, text: string) => void alerts.push([subject, text]),
  now: () => new Date('2026-11-20T16:05:00Z'),
});
const count = async (table: string) =>
  (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

describe('caseIntake', () => {
  it('files the case and emails a receipt whose link opens that party', async () => {
    const out = await caseIntake(input(), deps());
    expect(out.receipt).toBe('queued');
    expect(verify.mock.calls).toEqual([['tt', '203.0.113.9']]);
    await settled();
    expect(send).toHaveBeenCalledTimes(1);
    const status = (await pg.query<{ status: string }>('SELECT status FROM case_notice')).rows;
    expect(status).toEqual([{ status: 'sent' }]);
    const mail = send.mock.calls[0][0] as {
      to: string;
      replyTo: string;
      subject: string;
      text: string;
    };
    expect(mail.to).toBe('A@Example.com');
    expect(mail.replyTo).toBe('dmca@civitai.com');
    expect((mail as { from?: string }).from).toBe('Civitai DMCA <notices@civitai.com>');
    expect(mail.subject).toBe(`We received your request (${out.publicRef})`);
    expect(mail.text).toContain('DMCA copyright notice on November 20, 2026, 4:05 PM UTC');
    const link = mail.text.match(/Continue: (\S+)/)![1];
    expect(link.startsWith(`https://civitai.example/requests/case/${out.publicRef}#t=`)).toBe(true);
    const token = link.split('#t=')[1];
    const party = (await pg.query<{ id: number }>('SELECT id FROM case_party')).rows[0];
    const row = await resolveAccessToken(
      mainDb,
      token,
      'CaseParty',
      new Date('2026-11-21T00:00:00Z')
    );
    expect(row?.resourceId).toBe(Number(party.id));
    // Only the token's hash is stored: no case row holds the link that works.
    const stored = await pg.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM case_notice WHERE body_snapshot LIKE '%' || $1 || '%' OR subject_snapshot LIKE '%' || $1 || '%')
        + (SELECT count(*) FROM case_event WHERE data::text LIKE '%' || $1 || '%')::int AS n`,
      [token]
    );
    expect(Number(stored.rows[0].n)).toBe(0);
    const snap = (
      await pg.query<{ body_snapshot: string }>('SELECT body_snapshot FROM case_notice')
    ).rows[0].body_snapshot;
    expect(snap).toContain(`/requests/case/${out.publicRef}#t=[link-token]`);
    // The platform it was filed on, for Legal: the challenge's hostname.
    const received = (
      await pg.query<{ data: { origin: string } }>(
        "SELECT data FROM case_event WHERE type = 'received'"
      )
    ).rows[0];
    expect(received.data.origin).toBe('civitai.red');
    const rec = (await pg.query<{ due_at: string }>('SELECT due_at FROM case_record')).rows[0];
    expect(new Date(rec.due_at).toISOString()).toBe('2026-11-22T16:05:00.000Z');
  });

  it('refuses bad values before spending the Turnstile token, writing nothing', async () => {
    await expect(
      caseIntake(input({ values: { ...values, 'good-faith': false } }), deps())
    ).rejects.toBeInstanceOf(IntakeRefusedError);
    expect(verify).not.toHaveBeenCalled();
    expect(await count('case_record')).toBe(0);
  });

  it('writes nothing when the challenge fails', async () => {
    verify.mockRejectedValueOnce(new TurnstileRefusedError());
    await expect(caseIntake(input(), deps())).rejects.toBeInstanceOf(TurnstileRefusedError);
    expect(await count('case_record')).toBe(0);
  });

  it('refuses a form that is not open', async () => {
    await expect(caseIntake(input({ processKey: 'likeness-claim' }), deps())).rejects.toMatchObject(
      {
        status: 404,
      }
    );
  });

  it('a resubmit of the same submission returns the same case and sends no second receipt', async () => {
    const a = await caseIntake(input(), deps());
    const b = await caseIntake(input(), deps());
    expect(b).toEqual({ publicRef: a.publicRef, receipt: 'duplicate' });
    await settled();
    expect(await count('case_record')).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('answers with the case when the receipt cannot go, and records why on the case', async () => {
    mint.fail = true;
    const out = await caseIntake(input(), deps());
    expect(out.publicRef).toMatch(/^TD-26-/);
    expect(out.receipt).toBe('error');
    expect(send).not.toHaveBeenCalled();
    const ev = (
      await pg.query<{ type: string }>("SELECT type FROM case_event WHERE type <> 'received'")
    ).rows;
    expect(ev).toEqual([{ type: 'receipt-unsent' }]);
  });

  const fillReceipts = async () => {
    for (let i = 0; i < RECEIPTS_PER_ADDRESS_PER_DAY; i++) {
      const c = await pg.query<{ id: number }>(
        "INSERT INTO case_record (public_ref, process_key, definition_version_id, state, source, received_at) VALUES ($1, 'dmca-notice', $2, 'received', 'form', now()) RETURNING id",
        [`TD-26-OLD00${i}`, versionId]
      );
      await pg.query(
        "INSERT INTO case_notice (case_id, target_key, notice_id, recipient_role, recipient_address, address_hash, subject_snapshot, body_snapshot) VALUES ($1, 0, 'receipt', 'claimant', 'a@example.com', $2, 's', 'b')",
        [c.rows[0].id, hashAddress('a@example.com')]
      );
    }
  };

  it('stops emailing one address past the daily cap, still filing the case', async () => {
    await fillReceipts();
    const out = await caseIntake(input(), deps());
    expect(out.receipt).toBe('capped');
    expect(send).not.toHaveBeenCalled();
    expect(await count('case_record')).toBe(RECEIPTS_PER_ADDRESS_PER_DAY + 1);
  });

  it('emails the receipt past the daily cap when the cap is off', async () => {
    await fillReceipts();
    const out = await caseIntake(input(), { ...deps(), receiptsPerAddressPerDay: null });
    await settled();
    expect(out.receipt).toBe('queued');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads the per-address cap from its env value: unset or junk keeps 5, 0 turns it off', () => {
    expect(receiptCapFromEnv(undefined)).toBe(RECEIPTS_PER_ADDRESS_PER_DAY);
    expect(receiptCapFromEnv('')).toBe(RECEIPTS_PER_ADDRESS_PER_DAY);
    expect(receiptCapFromEnv('lots')).toBe(RECEIPTS_PER_ADDRESS_PER_DAY);
    expect(receiptCapFromEnv('-1')).toBe(RECEIPTS_PER_ADDRESS_PER_DAY);
    expect(receiptCapFromEnv('0')).toBeNull();
    expect(receiptCapFromEnv('20')).toBe(20);
  });

  it('flags a case whose submitter says the person shown is a minor, and alerts with the reference only', async () => {
    const out = await caseIntake(input({ values: { ...values, minor: true } }), deps());
    await settled();
    expect((await pg.query('SELECT minor_flag FROM case_record')).rows).toEqual([
      { minor_flag: true },
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].join(' ')).toContain(out.publicRef);
    expect(alerts[0].join(' ')).not.toContain('example.com');
  });

  it('raises no alert for an ordinary request', async () => {
    await caseIntake(input(), deps());
    await settled();
    expect((await pg.query('SELECT minor_flag FROM case_record')).rows).toEqual([
      { minor_flag: false },
    ]);
    expect(alerts).toEqual([]);
  });
});
