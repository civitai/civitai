/**
 * Seed the upload scan label queue from a JSONL file of earlier scan flags.
 *
 * Usage:
 *   pnpm run tsscript scripts/oneoffs/seed-scan-label-items.ts --seed=<file.jsonl> \
 *     [--expected-ids=<file>] [--flagger-version=<v>] [--apply]
 *
 * Each line: {"imageId", "workflowId", "flaggedAt" (ISO), "reason", "snapshot"}.
 * `--expected-ids` is any text file; every integer in the last backtick span is an id that must be
 * in the seed unless its image no longer exists, so a truncated seed file is refused, not half-run.
 *
 * Without `--apply` the whole seed runs inside a transaction that is rolled back, so the counts it
 * prints are the ones an apply would produce. Writes only the two scan label tables; idempotent on
 * `imageId` and `workflowId`, so a re-run is a no-op. `--apply` requires `--expected-ids`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SeedRow = {
  imageId: number;
  workflowId: string;
  flaggedAt: string;
  reason: string | null;
  snapshot: Record<string, unknown> | null;
};

export type Queryable = {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
};

export function parseSeed(text: string): SeedRow[] {
  const rows: SeedRow[] = [];
  const seenImages = new Set<number>();
  const seenWorkflows = new Set<string>();
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const where = `line ${i + 1}`;
    const raw = JSON.parse(line) as Partial<SeedRow>;
    if (!Number.isInteger(raw.imageId) || (raw.imageId as number) <= 0)
      throw new Error(`${where}: bad imageId`);
    if (typeof raw.workflowId !== 'string' || !raw.workflowId)
      throw new Error(`${where}: bad workflowId`);
    if (typeof raw.flaggedAt !== 'string' || Number.isNaN(Date.parse(raw.flaggedAt)))
      throw new Error(`${where}: bad flaggedAt`);
    if (raw.reason != null && typeof raw.reason !== 'string')
      throw new Error(`${where}: bad reason`);
    if (raw.snapshot != null && (typeof raw.snapshot !== 'object' || Array.isArray(raw.snapshot)))
      throw new Error(`${where}: bad snapshot`);
    const imageId = raw.imageId as number;
    if (seenImages.has(imageId)) throw new Error(`${where}: duplicate imageId ${imageId}`);
    if (seenWorkflows.has(raw.workflowId)) throw new Error(`${where}: duplicate workflowId`);
    seenImages.add(imageId);
    seenWorkflows.add(raw.workflowId);
    rows.push({
      imageId,
      workflowId: raw.workflowId,
      flaggedAt: raw.flaggedAt,
      reason: raw.reason ?? null,
      snapshot: raw.snapshot ?? null,
    });
  });
  return rows;
}

/** Every integer in the file's last backtick span. */
export function parseExpectedIds(text: string): number[] {
  const spans = text.match(/`[^`]*`/g);
  const last = spans?.[spans.length - 1] ?? '';
  return (last.match(/\d+/g) ?? []).map(Number);
}

export type SeedReport = {
  rows: number;
  missingImages: number[];
  itemsInserted: number;
  flagsInserted: number;
};

export async function seed(
  db: Queryable,
  rows: SeedRow[],
  { flaggerVersion, expectedIds = [] }: { flaggerVersion: string; expectedIds?: number[] }
): Promise<SeedReport> {
  const ids = [...new Set([...rows.map((r) => r.imageId), ...expectedIds])];
  const { rows: existing } = await db.query<{ id: number }>(
    `SELECT id FROM "Image" WHERE id = ANY($1::int[])`,
    [ids]
  );
  const exists = new Set(existing.map((r) => r.id));
  const inSeed = new Set(rows.map((r) => r.imageId));
  const absent = expectedIds.filter((id) => !inSeed.has(id) && exists.has(id));
  if (absent.length)
    throw new Error(
      `${
        absent.length
      } expected ids are missing from the seed while their images still exist: ${absent
        .slice(0, 10)
        .join(',')}`
    );

  let itemsInserted = 0;
  let flagsInserted = 0;
  for (const row of rows) {
    if (!exists.has(row.imageId)) continue;
    const { rows: item } = await db.query<{ id: number; inserted: boolean }>(
      `INSERT INTO "ScanLabelItem" ("imageId", "lane", "firstFlaggedAt", "status")
       VALUES ($1, 'flagged', $2, 'open')
       ON CONFLICT ("imageId") DO UPDATE
         SET "firstFlaggedAt" = LEAST("ScanLabelItem"."firstFlaggedAt", EXCLUDED."firstFlaggedAt")
       RETURNING id, (xmax = 0) AS inserted`,
      [row.imageId, row.flaggedAt]
    );
    if (item[0].inserted) itemsInserted++;
    const { rows: flag } = await db.query(
      `INSERT INTO "ScanLabelFlag"
         ("itemId", "source", "flaggerVersion", "reason", "workflowId", "flaggedAt", "snapshot")
       VALUES ($1, 'orchestrator-scan', $2, $3, $4, $5, $6)
       ON CONFLICT ("workflowId") DO NOTHING
       RETURNING id`,
      [item[0].id, flaggerVersion, row.reason, row.workflowId, row.flaggedAt, row.snapshot]
    );
    flagsInserted += flag.length;
  }
  return {
    rows: rows.length,
    missingImages: rows.filter((r) => !exists.has(r.imageId)).map((r) => r.imageId),
    itemsInserted,
    flagsInserted,
  };
}

async function main() {
  const arg = (name: string) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const apply = process.argv.includes('--apply');
  const seedPath = arg('seed');
  if (!seedPath) throw new Error('--seed=<file.jsonl> is required');
  const expectedPath = arg('expected-ids');
  const flaggerVersion = arg('flagger-version') ?? 'orchestrator@2026-10-12';

  const rows = parseSeed(readFileSync(seedPath, 'utf8'));
  const expectedIds = expectedPath ? parseExpectedIds(readFileSync(expectedPath, 'utf8')) : [];
  if (apply && !expectedIds.length)
    throw new Error('--apply needs --expected-ids pointing at a file with at least one id');
  console.log(
    `[seed] apply=${apply} rows=${rows.length} expectedIds=${expectedIds.length} version=${flaggerVersion}`
  );

  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const report = await seed(client, rows, { flaggerVersion, expectedIds });
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(`[seed] ${apply ? 'COMMITTED' : 'DRY RUN, rolled back'}`, JSON.stringify(report));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
