import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import type { LabText } from '$lib/text-scan-lab/types';
import {
  PROMPT_IDS,
  useMainDb,
  useTestSetsDb,
  seedCase,
  seedRun,
  seedSet,
} from './text-scan-tests-pglite.harness';

const dbs = vi.hoisted(() => ({ main: null as unknown, moderator: null as unknown }));

vi.mock('$lib/server/db', () => ({
  get dbRead() {
    return dbs.main;
  },
  get dbWrite() {
    return dbs.main;
  },
}));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => dbs.moderator }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn(async () => undefined) }));
vi.mock('$lib/server/user-actions.service', () => ({
  callModEndpoint: vi.fn(),
  callModEndpointAs: vi.fn(),
  requestCookie: vi.fn(() => null),
}));

const { workerDeps } = await import('../text-scan-tests/deps');
const { canonicalRuleState, ruleStateHash } = await import('../text-scan-tests/rule-state');
const { runWorker } = await import('../text-scan-tests/worker');

const RULES_STUB = `
  CREATE TABLE "ModerationRule" (
    id integer PRIMARY KEY, "entityType" text NOT NULL, enabled boolean NOT NULL DEFAULT true
  );
  CREATE TABLE "ModerationRuleVersion" (id integer PRIMARY KEY, "ruleId" integer NOT NULL);
`;

let db: Kysely<ModeratorDB>;
let main: Kysely<MainDB>;

const sets = useTestSetsDb();
const mains = useMainDb(RULES_STUB);

beforeEach(async () => {
  ({ db } = sets);
  ({ main } = mains);
  await mains.pg.exec(`
    INSERT INTO "ModerationRule" VALUES (1, 'Model', true), (2, 'Model', false), (3, 'Image', true);
    INSERT INTO "ModerationRuleVersion" VALUES (10, 1), (11, 1), (20, 2), (30, 3);
  `);
  dbs.main = main;
  dbs.moderator = db;
});

const liveHash = () => {
  const check = workerDeps('civ-token=synthetic').liveRuleStateHash;
  expect(check).toBeTypeOf('function');
  return check!();
};

describe('the production rule-state check', () => {
  it('hashes the Model rules, their latest versions and enabled flags, stably', async () => {
    const first = await liveHash();
    expect(first).toBe(
      ruleStateHash([
        { id: 1, versionId: 11, enabled: true },
        { id: 2, versionId: 20, enabled: false },
      ])
    );
    expect(await liveHash()).toBe(first);
  });

  it('changes when a Model rule is saved or toggled, not when another entity type changes', async () => {
    const before = await liveHash();
    await main
      .insertInto('ModerationRuleVersion')
      .values({ id: 31, ruleId: 3 } as never)
      .execute();
    expect(await liveHash()).toBe(before);

    await main
      .insertInto('ModerationRuleVersion')
      .values({ id: 12, ruleId: 1 } as never)
      .execute();
    const saved = await liveHash();
    expect(saved).not.toBe(before);

    await main.updateTable('ModerationRule').set({ enabled: true }).where('id', '=', 2).execute();
    expect(await liveHash()).not.toBe(saved);
  });

  it('canonicalises regardless of order', () => {
    const a = [
      { id: 2, versionId: 5, enabled: true },
      { id: 1, versionId: null, enabled: false },
    ];
    expect(canonicalRuleState(a)).toBe(canonicalRuleState([...a].reverse()));
  });

  it('lets a Model rules run with unchanged rules finish', async () => {
    const setId = await seedSet(db, { workspace: 'modelRules' });
    await seedCase(db, setId, { entityType: 'Model', expected: {} });
    const runId = await seedRun(db, setId, { ruleStateHash: await liveHash() });
    const scanTexts = vi.fn(async (_type: string, texts: LabText[]) => ({
      results: texts.map((t) => ({
        key: t.key,
        ok: true as const,
        workflowId: 'wf',
        promptIds: PROMPT_IDS,
        output: {},
        elapsedMs: 1,
      })),
      system: null,
      rules: null,
    }));
    await runWorker({ ...workerDeps('civ-token=synthetic'), scanTexts }, runId);

    expect(scanTexts).toHaveBeenCalledOnce();
    const run = await db
      .selectFrom('text_scan_test_run')
      .select(['status', 'failure'])
      .where('id', '=', String(runId))
      .executeTakeFirstOrThrow();
    expect(run).toEqual({ status: 'done', failure: null });
  });
});
