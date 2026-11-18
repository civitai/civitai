import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { executableSchemaSql } from './abuse-detection-pglite.harness';

/**
 * `apps/moderator/csam-archive/schema.sql` under the archiver's own login. The archiver
 * (civitai/csam-archiver `src/runlog.ts`) swallows a failed run-log write as a warning, so a grant
 * that is one column short shows up nowhere but here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, '../../../../csam-archive/schema.sql'), 'utf8');

// civitai/csam-archiver src/runlog.ts, verbatim: start, finish, alertNotDelivered.
const START = `INSERT INTO csam_archive_run (kind, report_id, preservation_id, user_id, mode, scope, archiver_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;
const FINISH = `UPDATE csam_archive_run
              SET finished_at = now(), outcome = $2, summary = $3::jsonb, verify = $4::jsonb,
                  archived = $5, error = $6
            WHERE id = $1`;
const ALERT_NOT_DELIVERED = `UPDATE csam_archive_run
              SET error = CASE WHEN error IS NULL OR error = '' THEN $2 ELSE error || '; ' || $2 END
            WHERE id = $1`;

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  // The schema grants only to a role that exists, so the login comes first, as in each environment.
  await db.exec(`CREATE ROLE csam_archiver`);
  await db.exec(executableSchemaSql(schemaSql));
});

afterEach(async () => {
  await db.close();
});

async function asArchiver<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE csam_archiver`);
  try {
    return await fn();
  } finally {
    await db.exec(`RESET ROLE`);
  }
}

async function startRun(): Promise<string> {
  const r = await db.query<{ id: string }>(START, [
    'report',
    990000002,
    null,
    990000001,
    'write',
    [1, 2, 6],
    'v0.2.10',
  ]);
  return String(r.rows[0].id);
}

describe('csam_archive_run under the archiver login', () => {
  it('runs every run-log statement: start, finish, and the undelivered-alert mark', async () => {
    const id = await asArchiver(async () => {
      const id = await startRun();
      await db.query(FINISH, [id, 'failed', JSON.stringify({ items: 3 }), null, false, null]);
      await db.query(ALERT_NOT_DELIVERED, [id, 'AlertNotDelivered']);
      return id;
    });

    const row = await db.query<{ outcome: string; error: string; archiver_version: string }>(
      `SELECT outcome, error, archiver_version FROM csam_archive_run WHERE id = $1`,
      [id]
    );
    expect(row.rows).toEqual([
      { outcome: 'failed', error: 'AlertNotDelivered', archiver_version: 'v0.2.10' },
    ]);
  });

  it('appends the mark to an error already on the row', async () => {
    const id = await asArchiver(async () => {
      const id = await startRun();
      await db.query(FINISH, [id, 'error', null, null, false, 'StoreError']);
      await db.query(ALERT_NOT_DELIVERED, [id, 'AlertNotDelivered']);
      return id;
    });

    const row = await db.query<{ error: string }>(
      `SELECT error FROM csam_archive_run WHERE id = $1`,
      [id]
    );
    expect(row.rows[0].error).toBe('StoreError; AlertNotDelivered');
  });

  it('cannot read what a run recorded', async () => {
    const readable = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'csam_archive_run'
          AND has_column_privilege('csam_archiver', 'csam_archive_run', column_name, 'SELECT')
        ORDER BY column_name`
    );
    expect(readable.rows.map((r) => r.column_name)).toEqual(['error', 'id']);

    await asArchiver(async () => {
      const id = await startRun();
      await expect(
        db.query(`SELECT summary FROM csam_archive_run WHERE id = $1`, [id])
      ).rejects.toThrow(/permission denied/);
      await expect(db.query(`DELETE FROM csam_archive_run WHERE id = $1`, [id])).rejects.toThrow(
        /permission denied/
      );
    });
  });
});
