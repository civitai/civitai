import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { executableSchemaSql } from './abuse-detection-pglite.harness';
import {
  CASE_NOTICE_STATUSES,
  CASE_PARTY_ROLES,
  CASE_PII_TABLES,
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

  it('gives the read-only role no access to personal data and read access to the rest', async () => {
    await db.exec(`CREATE ROLE internal_tools_ro`);
    await db.exec(DDL);
    const { rows } = await db.query<{ table_name: string; can_read: boolean }>(
      `SELECT t AS table_name, has_any_column_privilege('internal_tools_ro', t, 'SELECT') AS can_read
       FROM unnest($1::text[]) t`,
      [TABLES]
    );
    const pii = new Set<string>(CASE_PII_TABLES);
    for (const { table_name, can_read } of rows)
      expect([table_name, can_read]).toEqual([table_name, !pii.has(table_name)]);
  });
  // The read-back in the header is what an applier runs in production; run it here, as written.
  it("the header's read-back tells an unapplied database from an applied one", async () => {
    const block = RAW.match(/-- Read back after applying[^\n]*\n((?:-- {3}.*\n)+)/);
    const query = block![1]
      .split('\n')
      .map((l) => l.replace(/^-- {3}/, ''))
      .join('\n');
    await db.exec(`CREATE ROLE internal_tools_ro`);
    // count(*) is bigint; compare as numbers.
    const readBack = async () =>
      (await db.query<unknown[]>(query, [], { rowMode: 'array' })).rows[0].map((v) =>
        typeof v === 'bigint' ? Number(v) : v
      );

    expect(await readBack()).toEqual([0, 0, 0, false, 0]);
    await db.exec(DDL);
    // PGlite connects as postgres, so the owner column reads 0 here and 7 under internal_tools.
    expect(await readBack()).toEqual([7, 0, 2, true, 84]);
  });
});
