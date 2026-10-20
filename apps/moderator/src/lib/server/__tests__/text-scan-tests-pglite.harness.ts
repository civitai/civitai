import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { hashLabFields } from '../text-scan-tests/text-hash';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEST_SETS_SCHEMA = readFileSync(
  join(HERE, '../../../../text-scan-test-sets/schema.sql'),
  'utf8'
);

// Empties every table between tests, so one instance can serve a whole file.
const TRUNCATE_ALL = `DO $$ DECLARE t text; BEGIN
  SELECT string_agg(format('%I', tablename), ', ') INTO t FROM pg_tables WHERE schemaname = 'public';
  IF t IS NOT NULL THEN EXECUTE 'TRUNCATE ' || t || ' RESTART IDENTITY CASCADE'; END IF;
END $$;`;

// Only the main-database columns the deletion check reads.
const MAIN_STUB = `
  CREATE TABLE "User" (id integer PRIMARY KEY, "deletedAt" timestamp);
  CREATE TABLE "Model" (id integer PRIMARY KEY, "userId" integer, "deletedAt" timestamp);
  CREATE TABLE "CommentV2" (id integer PRIMARY KEY, "userId" integer);
`;

function usePglite(schema: string): { pg: PGlite } {
  const handle = {} as { pg: PGlite };
  // One instance per file: PGlite takes seconds to boot, which times out a per-test hook when
  // files run in parallel.
  beforeAll(async () => {
    handle.pg = await freshPglite();
    await handle.pg.exec(schema);
  }, 60_000);
  beforeEach(() => handle.pg.exec(TRUNCATE_ALL));
  afterAll(() => handle.pg?.close());
  return handle;
}

/** Call at file scope; read `db` in tests or a later `beforeEach`. Every table is empty per test. */
export function useTestSetsDb(): { readonly pg: PGlite; readonly db: Kysely<ModeratorDB> } {
  const handle = usePglite(TEST_SETS_SCHEMA);
  let db: Kysely<ModeratorDB> | undefined;
  return {
    get pg() {
      return handle.pg;
    },
    get db() {
      return (db ??= new Kysely<ModeratorDB>({ dialect: pgliteDialect(handle.pg) }));
    },
  };
}

/** The main-database stub, plus `extraSchema`; as `useTestSetsDb`. */
export function useMainDb(extraSchema = ''): {
  readonly pg: PGlite;
  readonly main: Kysely<MainDB>;
} {
  const handle = usePglite(MAIN_STUB + extraSchema);
  let main: Kysely<MainDB> | undefined;
  return {
    get pg() {
      return handle.pg;
    },
    get main() {
      return (main ??= new Kysely<MainDB>({ dialect: pgliteDialect(handle.pg) }));
    },
  };
}

export const MOD = 990001;

export async function seedSet(
  db: Kysely<ModeratorDB>,
  over: { name?: string; workspace?: 'prompts' | 'modelRules' } = {}
): Promise<number> {
  const row = await db
    .insertInto('text_scan_test_set')
    .values({
      name: over.name ?? `set ${Math.random().toString(36).slice(2, 8)}`,
      workspace: over.workspace ?? 'prompts',
      created_by: MOD,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

export async function seedCase(
  db: Kysely<ModeratorDB>,
  setId: number,
  over: {
    entityType?: string;
    entityId?: number | null;
    authorId?: number | null;
    text?: string;
    expected?: unknown;
    fields?: null;
  } = {}
): Promise<number> {
  const text = over.text ?? `synthetic text ${Math.random().toString(36).slice(2, 8)}`;
  const row = await db
    .insertInto('text_scan_test_case')
    .values({
      set_id: String(setId),
      entity_type: over.entityType ?? 'CommentV2',
      entity_id: over.entityId ?? null,
      author_id: over.authorId ?? null,
      fields: over.fields === null ? null : JSON.stringify([{ heading: 'Comment', text }]),
      source_deleted_at: over.fields === null ? new Date() : null,
      text_hash: hashLabFields([{ heading: 'Comment', text }]),
      expected: JSON.stringify(over.expected ?? { scam: false }),
      origin: 'try',
      added_by: MOD,
      updated_by: MOD,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

export const PROMPT_IDS = { base: 1, scam: 2 };

export async function seedRun(
  db: Kysely<ModeratorDB>,
  setId: number,
  over: {
    kind?: 'baseline' | 'draft';
    status?: string;
    startId?: string;
    baselineRunId?: number | null;
    maxCaseId?: number;
    promptIds?: Record<string, number>;
    promptOverrides?: Record<string, string> | null;
    ruleOverrides?: unknown[] | null;
    ruleStateHash?: string | null;
    model?: string;
    thinking?: boolean;
    leaseOwner?: string | null;
    heartbeatAt?: Date | null;
    runBy?: number;
    finishedAt?: Date | null;
    totals?: unknown;
    expiresAt?: Date | null;
  } = {}
): Promise<number> {
  const draft = over.kind === 'draft';
  const row = await db
    .insertInto('text_scan_test_run')
    .values({
      set_id: String(setId),
      kind: over.kind ?? 'baseline',
      start_id: over.startId ?? randomUUID(),
      baseline_run_id: over.baselineRunId == null ? null : String(over.baselineRunId),
      max_case_id: String(over.maxCaseId ?? 2_000_000_000),
      prompt_ids: JSON.stringify(over.promptIds ?? PROMPT_IDS),
      prompt_overrides: draft && over.promptOverrides ? JSON.stringify(over.promptOverrides) : null,
      rule_overrides: draft && over.ruleOverrides ? JSON.stringify(over.ruleOverrides) : null,
      rule_state_hash: over.ruleStateHash ?? null,
      model: over.model ?? 'model-a',
      thinking: over.thinking ?? false,
      status: over.status ?? 'queued',
      lease_owner: over.leaseOwner ?? null,
      heartbeat_at: over.heartbeatAt ?? null,
      run_by: over.runBy ?? MOD,
      finished_at: over.finishedAt ?? null,
      totals: over.totals === undefined ? null : JSON.stringify(over.totals),
      expires_at: draft ? over.expiresAt ?? null : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

export const resultsOf = (db: Kysely<ModeratorDB>, runId: number) =>
  db
    .selectFrom('text_scan_test_result')
    .selectAll()
    .where('run_id', '=', String(runId))
    .orderBy('case_id')
    .execute();
