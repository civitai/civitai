#!/usr/bin/env node
/**
 * "EcosystemCheckpoints" coverage rows, and the version cache bust that makes a change visible.
 * See SKILL.md. Writes go through the postgres-query skill and are dry runs unless --writable.
 */

import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { API_URL, createCli, isMain, trpcCall, whoami } from '../mod-actions/lib.mjs';

const QUERY_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../postgres-query/query.mjs');

export function resolveDbTarget(db) {
  if (db) {
    if (!['prod', 'dev'].includes(db)) throw new Error('--db must be prod or dev');
    return db;
  }
  if (!/^https:\/\/civitai\.(com|red)$/.test(API_URL))
    throw new Error(`the API target is ${API_URL}, so the database is ambiguous. Pass --db prod or --db dev.`);
  return 'prod';
}

function runSql(sql, { db, write = false } = {}) {
  const args = [QUERY_SCRIPT, `--${resolveDbTarget(db)}`, '--json', ...(write ? ['--writable'] : []), sql];
  const result = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  const target = result.stderr?.split('\n').find((line) => line.startsWith('Target:'));
  if (result.status !== 0) throw new Error(`postgres-query failed:\n${result.stderr.trim()}`);
  return { ...JSON.parse(result.stdout), target };
}

/** Read-only query through postgres-query; returns `{ rows, rowCount, fields }`. */
export function queryDb(sql, { db } = {}) {
  return runSql(sql, { db });
}

function assertVersionId(id) {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`not a model version id: ${id}`);
}

export function readCoverageRow(versionId, { db } = {}) {
  assertVersionId(versionId);
  return runSql(`SELECT id, name FROM "EcosystemCheckpoints" WHERE id = ${versionId}`, { db }).rows[0];
}

export async function bustVersion(id) {
  await trpcCall('modelVersion.bustCache', { id });
  console.log(`Busted caches for version ${id}.`);
}

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

if (isMain(import.meta.url)) {
  const { flags, writable, required, requiredInt, fail, dryRun, dispatch } = createCli(['writable']);
  const db = flags.db;

  const add = async () => {
    const id = requiredInt('version');
    const name = required('name');
    const sql = `INSERT INTO "EcosystemCheckpoints" (id, name) VALUES (${id}, ${sqlString(name)}) ON CONFLICT (id) DO NOTHING RETURNING id`;
    const existing = readCoverageRow(id, { db });

    if (!writable) {
      console.log(`[dry run] ${sql}`);
      console.log(existing ? `A row already exists: ${JSON.stringify(existing)}` : 'No row exists yet.');
      return console.log('Re-run with --writable to apply (also busts the version cache).');
    }
    if (existing) {
      console.log(`Coverage row already present: ${JSON.stringify(existing)}`);
    } else {
      const { rows, target } = runSql(sql, { db, write: true });
      console.log(target);
      if (!rows.length) fail('the INSERT returned no row; check the table by hand');
      console.log(`Added "EcosystemCheckpoints" row (${id}, ${sqlString(name)}).`);
      if (!readCoverageRow(id, { db }))
        console.log('Not yet visible on the read replica — re-check with `status` in a moment.');
    }
    await bustVersion(id);
  };

  const remove = async () => {
    const id = requiredInt('version');
    const sql = `DELETE FROM "EcosystemCheckpoints" WHERE id = ${id} RETURNING id, name`;
    if (!writable) {
      console.log(`[dry run] ${sql}`);
      const existing = readCoverageRow(id, { db });
      console.log(existing ? `Would remove: ${JSON.stringify(existing)}` : 'No row exists — nothing to remove.');
      return console.log('Re-run with --writable to apply (also busts the version cache).');
    }
    const { rows, target } = runSql(sql, { db, write: true });
    console.log(target);
    console.log(rows.length ? `Removed ${JSON.stringify(rows[0])}.` : 'No row existed.');
    await bustVersion(id);
  };

  const status = async () => {
    const id = requiredInt('version');
    const { rows } = runSql(
      `SELECT ec.name AS "ecosystemCheckpointsName", gc.covered
       FROM "ModelVersion" mv
       LEFT JOIN "EcosystemCheckpoints" ec ON ec.id = mv.id
       LEFT JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id
       WHERE mv.id = ${id}`,
      { db }
    );
    if (!rows.length) return console.log(`No model version ${id}.`);
    const [row] = rows;
    console.log(`EcosystemCheckpoints: ${row.ecosystemCheckpointsName ? `yes ("${row.ecosystemCheckpointsName}")` : 'no'}`);
    console.log(`GenerationCoverage:   ${row.covered ? 'covered' : 'not covered'}`);
  };

  const bust = async () => {
    const id = requiredInt('version');
    if (!writable) return dryRun('modelVersion.bustCache', { id });
    await bustVersion(id);
  };

  const HELP = `Usage: node .claude/skills/generation-coverage/coverage.mjs <command> [flags]

  whoami
  status   --version <id>
  add      --version <id> --name <label> [--writable]
  remove   --version <id> [--writable]
  bust     --version <id> [--writable]

add and remove bust the version cache themselves.
Uses postgres-query --prod unless --db dev is passed.`;

  dispatch({ whoami, status, add, remove, bust }, HELP);
}
