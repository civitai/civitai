import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { executableSchemaSql, pgliteDialect } from './abuse-detection-pglite.harness';
import { readPiiLockdown } from '../cases/pii-lockdown';
import {
  CASE_NOTICE_STATUSES,
  CASE_PARTY_ROLES,
  CASE_CLOSED_TABLES,
  CASE_SOURCES,
  CASE_TARGET_STATES,
  CASES_COLUMNS,
} from '../cases/cases-tables';

/** `apps/moderator/cases/schema.sql`, applied to a real in-process Postgres. */

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(HERE, '../../../../cases/schema.sql'), 'utf8');
const DDL = executableSchemaSql(RAW);
const TABLES = Object.keys(CASES_COLUMNS);

let db: PGlite;
beforeEach(async () => {
  db = await freshPglite();
});
afterEach(async () => {
  await db.close();
});

async function seedCase(publicRef = 'TD-26-AAAAAA') {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO case_record (public_ref, process_key, state, source, received_at)
     VALUES ($1, 'backlog-2026-11', 'Open', 'import', now()) RETURNING id`,
    [publicRef]
  );
  return rows[0].id;
}

const insertNotice = (caseId: string, targetKey = 0) =>
  db.query(
    `INSERT INTO case_notice (case_id, target_key, notice_id, recipient_role, recipient_address,
       address_hash, subject_snapshot, body_snapshot)
     VALUES ($1, $2, 'T4', 'uploader', 'a@example.test', 'h', 's', 'b')`,
    [caseId, targetKey]
  );

const lockdown = () => readPiiLockdown(new Kysely<unknown>({ dialect: pgliteDialect(db) }));

/** The header's read-back query, as an applier would paste it. */
const HEADER_QUERY = (() => {
  const block = RAW.match(/-- Read back after applying[^\n]*\n((?:-- {3}.*\n)+)/);
  return block![1]
    .split('\n')
    .map((l) => l.replace(/^-- {3}/, ''))
    .join('\n');
})();
// count(*) is bigint; compare as numbers.
const headerReadBack = async () =>
  (await db.query<unknown[]>(HEADER_QUERY, [], { rowMode: 'array' })).rows[0].map((v) =>
    typeof v === 'bigint' ? Number(v) : v
  );

describe('cases/schema.sql', () => {
  it('stops psql on the first error', () => {
    // The harness strips psql meta-commands to run the file, so their presence is checked as text.
    expect(RAW).toMatch(/^\\set ON_ERROR_STOP on$/m);
  });

  it('applies twice without error (re-runnable)', async () => {
    await db.exec(DDL);
    await db.exec(DDL);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [TABLES]
    );
    expect(rows[0].n).toBe(7);
  });

  it('has exactly the columns cases-tables.ts declares, and the header states their count', async () => {
    await db.exec(DDL);
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [TABLES]
    );
    const actual = Object.fromEntries(
      TABLES.map((t) => [
        t,
        rows
          .filter((r) => r.table_name === t)
          .map((r) => r.column_name)
          .sort(),
      ])
    );
    const declared = Object.fromEntries(
      Object.entries(CASES_COLUMNS).map(([t, cols]) => [t, [...cols].sort()])
    );
    expect(actual).toEqual(declared);

    const total = Object.values(CASES_COLUMNS).reduce((n, cols) => n + cols.length, 0);
    expect(rows).toHaveLength(total);
    // The read-back in the file's header prints this count as its 5th column.
    const header = RAW.match(/Expected: 7 \| 7 \| 2 \| t \| (\d+)/);
    expect(header?.[1]).toBe(String(total));
  });

  it('refuses a second notice with the same case, target, notice and recipient', async () => {
    await db.exec(DDL);
    const caseId = await seedCase();
    await insertNotice(caseId);
    await expect(insertNotice(caseId)).rejects.toThrow(/case_notice_idem_key/);
    await insertNotice(caseId, 1); // another target is another notice
  });

  it('refuses a second case with the same public reference, or the same submission', async () => {
    await db.exec(DDL);
    await seedCase('TD-26-BBBBBB');
    await expect(seedCase('TD-26-BBBBBB')).rejects.toThrow(/case_record_public_ref_key/);

    const submit = (ref: string) =>
      db.query(
        `INSERT INTO case_record (public_ref, process_key, state, source, received_at, submission_id)
         VALUES ($1, 'dmca', 'Open', 'form', now(), 'sub-1')`,
        [ref]
      );
    await submit('TD-26-CCCCCC');
    await expect(submit('TD-26-DDDDDD')).rejects.toThrow(/submission_id/);
  });

  it('writes one removal attempt once', async () => {
    await db.exec(DDL);
    const caseId = await seedCase();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO case_target (case_id, url) VALUES ($1, 'https://example.test/i/1') RETURNING id`,
      [caseId]
    );
    const started = (attempt: number) =>
      db.query(
        `INSERT INTO case_event (case_id, case_target_id, type, attempt)
         VALUES ($1, $2, 'action_started', $3)`,
        [caseId, rows[0].id, attempt]
      );
    await started(1);
    await expect(started(1)).rejects.toThrow(/case_event_attempt_key/);
    await started(2);
  });

  // Each value set in cases-tables.ts must be exactly what its CHECK admits.
  it.each([
    ['case_record', 'source', CASE_SOURCES, 'case_record_source_check'],
    ['case_target', 'state', CASE_TARGET_STATES, 'case_target_state_check'],
    ['case_notice', 'status', CASE_NOTICE_STATUSES, 'case_notice_status_check'],
    ['case_party', 'role', CASE_PARTY_ROLES, 'case_party_role_check'],
  ] as const)('%s.%s admits exactly its declared values', async (_t, _c, values, constraint) => {
    await db.exec(DDL);
    const { rows } = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraint]
    );
    const admitted = [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(admitted).toEqual([...values].sort());
  });

  it('leaves the read-only role the definitions and nothing else, whatever it was granted before', async () => {
    await db.exec(`CREATE ROLE internal_tools_ro`);
    // A broad default set up earlier is the case the REVOKE exists for: without it, every new table
    // would be readable and writable.
    await db.exec(`ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO internal_tools_ro`);
    await db.exec(DDL);
    const { rows } = await db.query<{ t: string; can_read: boolean; can_write: boolean }>(
      `SELECT t, has_any_column_privilege('internal_tools_ro', t, 'SELECT') AS can_read,
              has_table_privilege('internal_tools_ro', t, 'INSERT, UPDATE, DELETE, TRUNCATE') AS can_write
       FROM unnest($1::text[]) t`,
      [TABLES]
    );
    const closed = new Set<string>(CASE_CLOSED_TABLES);
    expect(rows.map((r) => [r.t, r.can_read, r.can_write])).toEqual(
      TABLES.map((t) => [t, !closed.has(t), false])
    );
    expect(await lockdown()).toBe('ok');
  });

  it('gives PUBLIC nothing on any case table', async () => {
    await db.exec(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC`);
    await db.exec(DDL);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM unnest($1::text[]) t
       WHERE has_table_privilege('public', t, 'SELECT')`,
      [TABLES]
    );
    expect(rows[0].n).toBe(0);
  });

  it('reports the lockdown open when the role can SET ROLE to one that reads a closed table', async () => {
    await db.exec(`CREATE ROLE internal_tools_ro`);
    await db.exec(DDL);
    expect(await lockdown()).toBe('ok');
    await db.exec(`CREATE ROLE readers; GRANT SELECT ON case_notice TO readers`);
    await db.exec(`GRANT readers TO internal_tools_ro WITH INHERIT FALSE`);
    expect(await lockdown()).toBe('open');
    expect((await headerReadBack())[3]).toBe(false);
  });

  it.each([
    ['to the role', `GRANT SELECT ON ALL TABLES IN SCHEMA public TO internal_tools_ro`],
    ['to PUBLIC', `GRANT SELECT ON case_notice TO PUBLIC`],
  ])('reports a read grant made after the apply %s as open', async (_, grant) => {
    await db.exec(`CREATE ROLE internal_tools_ro`);
    await db.exec(DDL);
    expect(await lockdown()).toBe('ok');
    await db.exec(grant);
    expect(await lockdown()).toBe('open');
    expect((await headerReadBack())[3]).toBe(false);
  });

  it('reports a write grant made after the apply, and a re-run removes it', async () => {
    await db.exec(`CREATE ROLE internal_tools_ro`);
    await db.exec(DDL);
    await db.exec(`GRANT UPDATE ON case_event TO internal_tools_ro`);
    expect(await lockdown()).toBe('open');
    await db.exec(DDL);
    expect(await lockdown()).toBe('ok');
  });

  it('reports a column-level write grant as open', async () => {
    await db.exec(`CREATE ROLE internal_tools_ro`);
    await db.exec(DDL);
    await db.exec(`GRANT UPDATE (state) ON case_record TO internal_tools_ro`);
    expect(await lockdown()).toBe('open');
    expect((await headerReadBack())[3]).toBe(false);
  });

  it('keeps the old CHECK when re-adding it fails, because each pair runs as one statement', async () => {
    await db.exec(DDL);
    await seedCase(); // source 'import'
    // The source block exactly as written, with 'import' narrowed out: psql runs it as one statement.
    const block = RAW.match(
      /DO \$\$\nBEGIN\n {2}ALTER TABLE case_record DROP CONSTRAINT IF EXISTS case_record_source_check;[\s\S]*?END \$\$;/
    )![0];
    await expect(db.exec(block.replace("'report', 'import'", "'report'"))).rejects.toThrow();
    const { rows } = await db.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'case_record_source_check'`
    );
    expect(rows).toHaveLength(1);
  });

  it('reports a write the role can reach through SET ROLE as open', async () => {
    await db.exec(`CREATE ROLE internal_tools_ro`);
    await db.exec(DDL);
    await db.exec(`CREATE ROLE writers; GRANT UPDATE ON case_event TO writers`);
    await db.exec(`GRANT writers TO internal_tools_ro WITH INHERIT FALSE`);
    expect(await lockdown()).toBe('open');
    expect((await headerReadBack())[3]).toBe(false);
  });

  it('reports no-role when the read-only role does not exist', async () => {
    await db.exec(DDL);
    expect(await lockdown()).toBe('no-role');
  });

  it('refuses a removal attempt with no target', async () => {
    await db.exec(DDL);
    const caseId = await seedCase();
    await expect(
      db.query(`INSERT INTO case_event (case_id, type, attempt) VALUES ($1, 'action_started', 1)`, [
        caseId,
      ])
    ).rejects.toThrow(/case_event_attempt_target_check/);
  });

  it('brings a changed value set back to the file on a re-run', async () => {
    await db.exec(DDL);
    await db.exec(`ALTER TABLE case_record DROP CONSTRAINT case_record_source_check;
      ALTER TABLE case_record ADD CONSTRAINT case_record_source_check CHECK (source IN ('form'))`);
    await db.exec(DDL);
    await expect(seedCase()).resolves.toBeDefined(); // source 'import' is admitted again
  });

  // The read-back in the header is what an applier runs in production; run it here, as written.
  it("the header's read-back tells an unapplied database from an applied one", async () => {
    await db.exec(`CREATE ROLE internal_tools_ro`);
    expect(await headerReadBack()).toEqual([0, 0, 0, false, 0]);
    await db.exec(DDL);
    // PGlite connects as postgres, so the owner column reads 0 here and 7 under internal_tools.
    expect(await headerReadBack()).toEqual([7, 0, 2, true, 84]);
    expect(await lockdown()).toBe('ok');
  });
});
