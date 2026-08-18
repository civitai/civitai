import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Prisma supplies its own @default on create, so the Postgres column default never applies. A
// default the payout read does not select makes an omitted-status row invisible to payout with no
// error and no drift — the shape that hid a wrong licence on ~65k models for two and a half years
// (#4036). Two halves have to agree with the Prisma default: the read backpay pays out from, and
// the column default committed in prisma/migrations.

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMA = path.join(REPO_ROOT, 'packages/civitai-db-schema/prisma/schema.full.prisma');
const BACKPAY = path.join(REPO_ROOT, 'src/server/services/blocks/backpay.service.ts');
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

// Slice from `start` (the index of an opening brace/paren) to its balanced partner, so a nested
// object cannot end the slice early and an unbalanced source throws rather than returning a
// truncated fragment.
function balancedSlice(src: string, start: number) {
  const open = src[start];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`guard cannot run: unbalanced ${open} at index ${start}`);
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

// The status the payout READ selects on. Update filters are deliberately excluded: a row the read
// never returns is never paid, whatever the updates match.
function payoutReadStatus() {
  const src = readOrThrow(BACKPAY);
  const marker = `dbRead.blockSpendAttribution.findMany(`;
  const at = src.indexOf(marker);
  if (at < 0)
    throw new Error(`guard cannot run: no dbRead.blockSpendAttribution.findMany in ${BACKPAY}`);
  if (src.indexOf(marker, at + 1) >= 0)
    throw new Error(
      'guard cannot run: more than one dbRead.blockSpendAttribution.findMany — this guard assumes ' +
        'a single payout read and can no longer tell which one pays out'
    );

  const call = balancedSlice(src, at + marker.length);
  const whereAt = call.indexOf('where:');
  if (whereAt < 0) throw new Error('guard cannot run: payout read has no where clause');
  const where = balancedSlice(call, call.indexOf('{', whereAt));

  const status = where.match(/status:\s*'([^']+)'/);
  if (!status)
    throw new Error(
      `guard cannot run: payout read filters on no status literal (where was ${where})`
    );
  return status[1];
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
    const sql = readOrThrow(file);
    if (!sql.includes(TABLE)) continue;

    for (const m of sql.matchAll(/"status"\s+TEXT[^,\n]*DEFAULT\s+'([^']+)'/g))
      columnDefault = m[1];
    for (const m of sql.matchAll(/ALTER\s+COLUMN\s+"status"\s+SET\s+DEFAULT\s+'([^']+)'/gi))
      columnDefault = m[1];
    for (const m of sql.matchAll(/CHECK\s*\(\s*"status"\s+IN\s*\(([^)]*)\)/gi))
      checkList = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }

  if (columnDefault === null)
    throw new Error(`guard cannot run: no status column default for ${TABLE} in prisma/migrations`);
  if (checkList === null)
    throw new Error(`guard cannot run: no status CHECK for ${TABLE} in prisma/migrations`);
  return { columnDefault, checkList };
}

describe('BlockSpendAttribution.status default', () => {
  it('is the status the payout read selects', () => {
    const fallback = schemaDefaultFor('BlockSpendAttribution', 'status');
    const read = payoutReadStatus();

    expect(
      fallback,
      `schema @default("${fallback}") is not what the payout read selects ('${read}'). A row ` +
        'created without an explicit status would never be paid out.'
    ).toBe(read);
  });

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
