import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Prisma supplies its own @default on create, so the Postgres column default never applies. A
// schema default the committed migrations do not provision makes a database built from history
// disagree with the one this code runs against, with no error and no drift — the shape that hid a
// wrong licence on ~65k models for two and a half years (#4036).
//
// This guard used to have a second half, pinning the schema default against the status the SPEND
// backpay read selected. That read is gone: the platform-funded spend bounty was removed, so
// nothing pays out from block_spend_attribution and there is no read to agree with. The half was
// dropped rather than left to fail closed on every run.

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMA = path.join(REPO_ROOT, 'packages/civitai-db-schema/prisma/schema.full.prisma');
const MIGRATIONS = path.join(REPO_ROOT, 'packages/civitai-db-schema/prisma/migrations');

const TABLE = 'block_spend_attribution';

function readOrThrow(file: string) {
  if (!fs.existsSync(file)) throw new Error(`guard cannot run: ${file} not found`);
  // Normalise CRLF: the matches below are line-anchored, and a checkout with Windows line endings
  // would otherwise make this guard fail on Windows only.
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (src.trim() === '') throw new Error(`guard cannot run: ${file} is empty`);
  return src;
}

function schemaDefaultFor(model: string, field: string) {
  const src = readOrThrow(SCHEMA);
  const block = src.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm'));
  if (!block) throw new Error(`guard cannot run: model ${model} not found in schema.full.prisma`);
  const line = block[1]
    .split('\n')
    .find((l) => new RegExp(`^\\s*${field}\\s`).test(l) && !l.trim().startsWith('//'));
  if (!line) throw new Error(`guard cannot run: ${model}.${field} not found`);
  const def = line.match(/@default\("([^"]+)"\)/);
  if (!def) throw new Error(`guard cannot run: ${model}.${field} has no string @default`);
  return def[1];
}

// The column default the committed migrations would provision, and the CHECK list that bounds it.
function migrationColumnState() {
  if (!fs.existsSync(MIGRATIONS)) throw new Error(`guard cannot run: ${MIGRATIONS} not found`);
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((d) => /^\d/.test(d))
    .sort()
    .map((d) => path.join(MIGRATIONS, d, 'migration.sql'))
    .filter((f) => fs.existsSync(f));
  if (files.length === 0) throw new Error('guard cannot run: no migration.sql files found');

  let columnDefault: string | null = null;
  let checkList: string[] | null = null;

  for (const file of files) {
    // 🔴 SCOPE TO STATEMENTS THAT TARGET THIS TABLE, NOT TO FILES THAT MENTION IT.
    // This used to be a file-level `if (!sql.includes(TABLE)) continue`, and it
    // read PROSE. A later migration creating a DIFFERENT table mentioned
    // `block_spend_attribution` only in its comment header — explaining why it was
    // a separate table — which passed the file filter; the `"status" TEXT … DEFAULT`
    // regex then matched THAT table's own status column, and because the match is
    // last-wins across sorted filenames the newer file won. The guard reported
    // `provisions DEFAULT 'accrued' … while the schema says @default("tracked")`
    // about a column neither the migration nor the schema had changed.
    //
    // That failure mode is worse than a false red: this guard exists because a
    // default the payout read does not select makes an omitted-status row invisible
    // to payout with no error and no drift (#4036). Anyone "fixing" it by following
    // its message and setting `@default("accrued")` on BlockSpendAttribution ships
    // precisely that defect. So the fix is here, not a reworded comment in the
    // other migration — a comment-level workaround leaves the next table to trip it.
    //
    // Comments are stripped first, then the file is split into statements, and only
    // statements naming the table are scanned. A statement about another table can
    // no longer contribute a default, a CHECK, or anything else.
    const sql = readOrThrow(file);
    if (!sql.includes(TABLE)) continue;

    const statements = sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((stmt) => stmt.includes(TABLE));

    for (const stmt of statements) {
      for (const m of stmt.matchAll(/"status"\s+TEXT[^,\n]*DEFAULT\s+'([^']+)'/g))
        columnDefault = m[1];
      for (const m of stmt.matchAll(/ALTER\s+COLUMN\s+"status"\s+SET\s+DEFAULT\s+'([^']+)'/gi))
        columnDefault = m[1];
      for (const m of stmt.matchAll(/CHECK\s*\(\s*"status"\s+IN\s*\(([^)]*)\)/gi))
        checkList = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    }
  }

  if (columnDefault === null)
    throw new Error(`guard cannot run: no status column default for ${TABLE} in prisma/migrations`);
  if (checkList === null)
    throw new Error(`guard cannot run: no status CHECK for ${TABLE} in prisma/migrations`);
  return { columnDefault, checkList };
}

describe('BlockSpendAttribution.status default', () => {
  it('matches the column default the committed migrations provision', () => {
    const fallback = schemaDefaultFor('BlockSpendAttribution', 'status');
    const { columnDefault, checkList } = migrationColumnState();

    expect(
      columnDefault,
      `prisma/migrations provisions DEFAULT '${columnDefault}' for ${TABLE}.status while the schema ` +
        `says @default("${fallback}"). A database built from the committed history disagrees with ` +
        'the one this code runs against.'
    ).toBe(fallback);

    expect(
      checkList,
      `the committed CHECK for ${TABLE}.status does not allow '${fallback}', so every insert into a ` +
        'database built from prisma/migrations fails with SQLSTATE 23514.'
    ).toContain(fallback);
  });
});
