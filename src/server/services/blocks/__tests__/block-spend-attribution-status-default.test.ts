import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Prisma supplies its own @default on create, so the Postgres column default never applies. A
// default here that backpay's selector does not match makes an omitted-status row invisible to
// payout with no error and no drift — the shape that hid a wrong licence on ~65k models for two
// and a half years (#4036). This pins the schema default against the selector that has to see it.

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMA = path.join(REPO_ROOT, 'packages/civitai-db-schema/prisma/schema.full.prisma');
const BACKPAY = path.join(REPO_ROOT, 'src/server/services/blocks/backpay.service.ts');

function readOrThrow(file: string) {
  if (!fs.existsSync(file)) throw new Error(`guard cannot run: ${file} not found`);
  // Normalise CRLF: the anchored model-block match below is line-based, and a checkout with
  // Windows line endings would otherwise make this guard fail on Windows only.
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

// Every status literal backpay filters blockSpendAttribution rows on.
function backpaySelectedStatuses() {
  const src = readOrThrow(BACKPAY);
  const statuses = new Set<string>();
  const calls = src.matchAll(
    /db(?:Read|Write)\.blockSpendAttribution\.\w+\(\{([\s\S]*?)\n {4}\}\)/g
  );
  for (const call of calls) {
    const where = call[1].match(/where:\s*\{([^}]*)\}/);
    if (!where) continue;
    const status = where[1].match(/status:\s*'([^']+)'/);
    if (status) statuses.add(status[1]);
  }
  if (statuses.size === 0)
    throw new Error(
      'guard cannot run: found no blockSpendAttribution status filter in backpay.service.ts'
    );
  return statuses;
}

describe('BlockSpendAttribution.status default', () => {
  it('is a status the backpay selector actually reads', () => {
    const fallback = schemaDefaultFor('BlockSpendAttribution', 'status');
    const selected = backpaySelectedStatuses();

    expect(
      selected.has(fallback),
      `schema @default("${fallback}") is not selected by backpay (it reads ${[...selected]
        .map((s) => `'${s}'`)
        .join(', ')}). A row created without an explicit status would never be paid out.`
    ).toBe(true);
  });

  it('is not the sibling tables’ vocabulary', () => {
    // 'pending' belongs to BlockBuzzAttribution / BlockSubscriptionAttribution. It was copied here,
    // where nothing reads it.
    expect(schemaDefaultFor('BlockSpendAttribution', 'status')).not.toBe('pending');
  });
});
