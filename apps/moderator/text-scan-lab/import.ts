/**
 * Seeds a NEW text-scan test set from a local JSON file.
 *
 *   CIVITAI_API_KEY=<your own key> pnpm --filter @civitai/moderator-app exec \
 *     tsx --env-file=.env text-scan-lab/import.ts --file <path.json> --set "<name>" --by <moderatorId> [--dry-run]
 *
 * File shape: `seed-file.ts`. Entity cases without `fields` snapshot the text `/api/mod/text-scan`
 * composeEntities returns (bills nothing); ids it cannot compose are skipped and counted. The set and
 * all cases are written in one transaction.
 *
 * Env: MODERATOR_DATABASE_URL, CIVITAI_APP_URL, and (only to compose entity cases without fields)
 * CIVITAI_API_KEY — the running moderator's own API key. `/api/mod/*` takes a moderator's key for
 * scripts; the spoke's forwarded-session path needs a browser request, which a script does not have.
 */
import { readFileSync } from 'node:fs';
import type { DB as ModeratorDB } from '../src/lib/server/moderator-db/types';
import {
  parseSeedFile,
  SeedFileError,
  type SeedCase,
} from '../src/lib/server/text-scan-lab/seed-file';
import { hashLabText } from '../src/lib/server/text-scan-lab/text-hash';
import { chunk } from '../src/lib/text-scan-lab/chunk';
import { normaliseLabFields } from '../src/lib/text-scan-lab/compose';
import { HARNESS_LIMITS } from '../src/lib/text-scan-lab/limits';
import type { LabEntityType } from '../src/lib/text-scan-lab/types';
import { CliError, createKyselyClients, requireEnv } from './cli';

const INSERT_BATCH = 200;

type Composed =
  | {
      entityId: number;
      ok: true;
      fields: { heading: string; text: string | null }[];
      userId: number | null;
    }
  | { entityId: number; ok: false; error: string };

type CaseRow = {
  entity_type: LabEntityType;
  entity_id: number | null;
  author_id: number | null;
  fields: string;
  text_hash: string;
  expected: string;
  synthetic: boolean;
  note: string | null;
};

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const file = get('--file');
  const set = get('--set')?.trim();
  const by = Number(get('--by'));
  if (!file) throw new CliError('--file is required');
  if (!set || set.length > 100) throw new CliError('--set needs a name of 1-100 characters');
  if (!Number.isInteger(by) || by < 1) throw new CliError('--by needs the moderator user id');
  return { file, set, by, dryRun: argv.includes('--dry-run') };
}

/** Host, port and database only — never the credentials. */
const describeDb = (connectionString: string) => {
  const u = new URL(connectionString);
  return `${u.hostname}:${u.port || 5432}${u.pathname}`;
};

async function composeEntities(
  appUrl: string,
  apiKey: string,
  entityType: LabEntityType,
  ids: number[]
): Promise<Composed[]> {
  const results: Composed[] = [];
  for (const entityIds of chunk(ids, HARNESS_LIMITS.textsPerRequest)) {
    const res = await fetch(`${appUrl}/api/mod/text-scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        action: 'composeEntities',
        entityType,
        entityIds,
      }),
      signal: AbortSignal.timeout(150_000),
    });
    if (!res.ok)
      throw new CliError(
        `composeEntities ${entityType} returned ${res.status}: ${(await res.text()).slice(0, 300)}`
      );
    results.push(...((await res.json()) as { results: Composed[] }).results);
  }
  return results;
}

/** Same normalisation and hash as the lab's own `addCase`, so an imported case matches one added by
 *  hand. Returns the skip reason when nothing can be stored. */
function toRow(
  c: SeedCase,
  fields: { heading: string; text: string | null }[],
  entityId: number | null,
  authorId: number | null
): CaseRow | string {
  const kept = normaliseLabFields(fields);
  if (typeof kept === 'string') return kept;
  if (!kept.length) return 'no text';
  return {
    entity_type: c.entityType,
    entity_id: entityId,
    author_id: authorId,
    fields: JSON.stringify(kept),
    text_hash: hashLabText(kept),
    expected: JSON.stringify(c.expected),
    synthetic: c.synthetic,
    note: c.note,
  };
}

async function buildRows(cases: SeedCase[], appUrl: string, apiKey: string | undefined) {
  const rows: CaseRow[] = [];
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1);

  const byType = new Map<LabEntityType, Map<number, SeedCase>>();
  for (const c of cases) {
    if (c.kind === 'text') {
      const row = toRow(c, c.fields, null, null);
      if (typeof row === 'string') skip(row);
      else rows.push(row);
      continue;
    }
    if (c.fields) {
      const row = toRow(c, c.fields, c.entityId, c.authorId ?? null);
      if (typeof row === 'string') skip(row);
      else rows.push(row);
      continue;
    }
    if (!byType.has(c.entityType)) byType.set(c.entityType, new Map());
    byType.get(c.entityType)!.set(c.entityId, c);
  }

  if (byType.size && !apiKey)
    throw new CliError('CIVITAI_API_KEY not set (needed for entity cases without fields)');
  for (const [entityType, byId] of byType) {
    for (const r of await composeEntities(appUrl, apiKey!, entityType, [...byId.keys()])) {
      const c = byId.get(r.entityId)!;
      if (!r.ok) {
        skip(r.error);
        continue;
      }
      const row = toRow(c, r.fields, r.entityId, r.userId);
      if (typeof row === 'string') skip(row);
      else rows.push(row);
    }
  }
  return { rows, skipped };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = parseSeedFile(JSON.parse(readFileSync(args.file, 'utf8')));
  const appUrl = (process.env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/$/, '');
  const dbUrl = requireEnv('MODERATOR_DATABASE_URL');
  // Before any request, so a wrong target is visible even when composing fails.
  console.log(
    JSON.stringify(
      { app: appUrl, moderatorDb: describeDb(dbUrl), set: args.set, dryRun: args.dryRun },
      null,
      2
    )
  );

  const { rows, skipped } = await buildRows(cases, appUrl, process.env.CIVITAI_API_KEY);
  const entityRows = rows.filter((r) => r.entity_id !== null).length;
  const summary = {
    cases: cases.length,
    entityCases: cases.filter((c) => c.kind === 'entity').length,
    freeTextCases: cases.filter((c) => c.kind === 'text').length,
    toInsert: { total: rows.length, entity: entityRows, freeText: rows.length - entityRows },
    synthetic: rows.filter((r) => r.synthetic).length,
    skipped,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!rows.length) throw new CliError('No case has text to import; nothing written.');

  const { db } = createKyselyClients<ModeratorDB>({ connectionString: dbUrl, singleClient: true });
  try {
    const existing = await db
      .selectFrom('text_scan_test_set')
      .select('id')
      .where('name', '=', args.set)
      .executeTakeFirst();
    if (existing)
      throw new CliError(
        `A test set named "${args.set}" already exists (id ${existing.id}); import into a new name.`
      );
    if (args.dryRun) {
      console.log('dry run: nothing written.');
      return;
    }
    const setId = await db.transaction().execute(async (trx) => {
      const set = await trx
        .insertInto('text_scan_test_set')
        .values({ name: args.set, description: null, created_by: args.by })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const batch of chunk(rows, INSERT_BATCH))
        await trx
          .insertInto('text_scan_test_case')
          .values(batch.map((r) => ({ ...r, set_id: set.id, added_by: args.by })))
          .execute();
      return set.id;
    });
    console.log(JSON.stringify({ setId: Number(setId), inserted: rows.length }));
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  if (err instanceof CliError || err instanceof SeedFileError) console.error(err.message);
  else console.error(err);
  process.exit(1);
});
