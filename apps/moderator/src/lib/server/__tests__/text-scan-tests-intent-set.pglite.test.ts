import { sql, type Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import type { LabIntentListing, LabOverrides } from '../text-scan-lab/harness-client';
import { LAB_LABELS, type LabEntityType, type LabText } from '$lib/text-scan-lab/types';
import type * as IntentSet from '$lib/text-scan-tests/intent-set';
import {
  MOD,
  useMainDb,
  useTestSetsDb,
  seedCase,
  seedRun,
  seedSet,
} from './text-scan-tests-pglite.harness';

// Every table restarts its ids per test, so the first set seeded is the pinned one.
const PINNED = 1;
vi.mock('$lib/text-scan-tests/intent-set', async (importOriginal) => {
  const real = await importOriginal<typeof IntentSet>();
  const isIntentEvalSet = (setId: number) => setId === PINNED;
  return {
    ...real,
    INTENT_EVAL_SET_ID: PINNED,
    isIntentEvalSet,
    caseLabels: (setId: number, entityType: LabEntityType) =>
      isIntentEvalSet(setId) ? real.INTENT_LABELS : LAB_LABELS[entityType],
  };
});
vi.mock('../user-actions.service', () => ({
  callModEndpoint: vi.fn(),
  callModEndpointAs: vi.fn(),
  readModEndpoint: vi.fn(),
  requestCookie: vi.fn(() => null),
}));

const { quoteRun, startRun } = await import('../text-scan-tests/runs');
const { runWorker } = await import('../text-scan-tests/worker');
const { upsertCase } = await import('../text-scan-tests/store');
const { importIntentCases, parseIntentRows } = await import('../text-scan-tests/intent-import');
const { importSeed } = await import('../text-scan-tests/seed');

let db: Kysely<ModeratorDB>;
let main: Kysely<MainDB>;
let pinned: number;
let other: number;

const sets = useTestSetsDb();
const mains = useMainDb();

beforeEach(async () => {
  vi.clearAllMocks();
  ({ db } = sets);
  ({ main } = mains);
  pinned = await seedSet(db, { name: 'civitai.com face intent (pinned)' });
  other = await seedSet(db);
  expect(pinned).toBe(PINNED);
});

const ACTIVE = {
  base: { id: 1, key: 'base', content: 'synthetic base' },
  'label:nsfw': { id: 2, key: 'label:nsfw', content: 'synthetic nsfw' },
  'label:model-com-face-intent': {
    id: 3,
    key: 'label:model-com-face-intent',
    content: 'synthetic intent',
  },
};

const runDeps = () => ({
  db,
  getPrompts: vi.fn(async () => ({
    active: { ...ACTIVE },
    config: { model: 'model-a', maxInputChars: 1000, thinking: false },
  })),
  quoteTexts: vi.fn(async () => ({ count: 1, quoted: 1, maxCostTotal: 1 })),
  launch: vi.fn(),
  audit: vi.fn(),
});

const LISTING = [
  { heading: 'Name', text: 'Retro Style' },
  { heading: 'Description', text: 'A retro style' },
  { heading: 'Trained words', text: 'retro' },
];

const importCase = (setId: number, modelId: number, expected: unknown) =>
  upsertCase(
    db,
    {
      setId,
      entityType: 'Model',
      entityId: modelId,
      authorId: 3,
      sourceRef: null,
      fields: LISTING,
      expected,
      note: null,
      origin: 'import',
    },
    MOD
  );

describe('a run on the pinned intent set', () => {
  it('records and asks for the intent label alone, keeping only the base and intent drafts', async () => {
    await importCase(pinned, 11, { 'model-com-face-intent': true });
    const deps = runDeps();
    const draft = {
      prompts: {
        'label:model-com-face-intent': 'synthetic intent draft',
        'label:nsfw': 'synthetic nsfw draft',
      },
    };
    const quote = await quoteRun(deps, pinned, 'prompts', draft);
    await startRun(deps, { setId: pinned, workspace: 'prompts', draft, stamp: quote.stamp }, MOD);
    const [baseline, drafted] = await db
      .selectFrom('text_scan_test_run')
      .selectAll()
      .orderBy('id')
      .execute();
    expect(baseline.prompt_ids).toEqual({ base: 1, 'model-com-face-intent': 3 });
    expect(drafted.prompt_ids).toEqual({ base: 1, 'model-com-face-intent': 0 });
    expect(drafted.prompt_overrides).toEqual({
      'label:model-com-face-intent': 'synthetic intent draft',
    });
  });

  it("sends the worker's scans the intent label; another set sends none", async () => {
    await importCase(pinned, 11, { 'model-com-face-intent': true });
    await sql`INSERT INTO "User" (id) VALUES (3)`.execute(main);
    await sql`INSERT INTO "Model" (id, "userId") VALUES (11, 3)`.execute(main);
    await seedCase(db, other, { entityType: 'Model', text: 'synthetic model' });
    const ids = { base: 1, 'model-com-face-intent': 3 };
    const seen: (LabOverrides | undefined)[] = [];
    const scanTexts = vi.fn(async (_type: string, texts: LabText[], overrides?: LabOverrides) => {
      seen.push(overrides);
      const promptIds = overrides?.labels ? ids : { base: 1, nsfw: 2, poi: 4, minor: 5 };
      return {
        results: texts.map((t) => ({
          key: t.key,
          ok: true as const,
          workflowId: `wf-${t.key}`,
          promptIds,
          output: { 'model-com-face-intent': { detected: true, reason: 'synthetic' } },
          elapsedMs: 1,
        })),
        system: null,
      };
    });
    const deps = { db, main, scanTexts, workerId: 'host-a:1:aaaa', log: vi.fn() };
    const pinnedRun = await seedRun(db, pinned, { promptIds: ids });
    await runWorker(deps, pinnedRun);
    const otherRun = await seedRun(db, other, {
      promptIds: { base: 1, nsfw: 2, poi: 4, minor: 5 },
    });
    await runWorker(deps, otherRun);
    expect(seen[0]).toEqual({ labels: ['model-com-face-intent'] });
    expect(seen[1]).toEqual({});
    const statuses = await db
      .selectFrom('text_scan_test_run')
      .select('status')
      .orderBy('id')
      .execute();
    expect(statuses.map((s) => s.status)).toEqual(['done', 'done']);
  });
});

describe('cases in the pinned intent set', () => {
  it('score the intent label alone', async () => {
    await expect(importCase(pinned, 11, { 'model-com-face-intent': false })).resolves.toMatchObject(
      {
        created: true,
      }
    );
    await expect(importCase(pinned, 12, { nsfw: { min: 'r', max: 'r' } })).rejects.toMatchObject({
      status: 400,
    });
    await expect(importCase(other, 11, { 'model-com-face-intent': true })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('come only from the import, never a capture or free text', async () => {
    for (const over of [
      { origin: 'try' as const },
      { origin: 'matches' as const },
      { entityId: null },
    ])
      await expect(
        upsertCase(
          db,
          {
            setId: pinned,
            entityType: 'Model',
            entityId: 11,
            authorId: 3,
            sourceRef: null,
            fields: LISTING,
            expected: {},
            note: null,
            origin: 'import',
            ...over,
          },
          MOD
        )
      ).rejects.toMatchObject({ status: 409 });
  });

  it('are never written by the seed script', async () => {
    const json = { cases: [{ entityType: 'Model', entityId: 11, fields: LISTING, expected: {} }] };
    await expect(
      importSeed(db, json, {
        set: 'civitai.com face intent (pinned)',
        workspace: 'prompts',
        format: 'lab-seed',
        by: MOD,
        write: true,
      })
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('importIntentCases', () => {
  const compose = vi.fn(
    async (ids: number[]): Promise<LabIntentListing[]> =>
      ids.map((entityId) =>
        entityId === 99
          ? { entityId, ok: false, error: 'not found' }
          : { entityId, ok: true, fields: LISTING, userId: 3 }
      )
  );

  it("stores each model's intent fields as the main app sent them, with its verdict", async () => {
    const rows = parseIntentRows('11 detected\n12 clear\n# a comment\n13 unsure\n99 clear');
    if (typeof rows === 'string') throw new Error(rows);
    expect(await importIntentCases({ db, compose }, pinned, rows, MOD)).toEqual({
      created: 3,
      updated: 0,
      notFound: [99],
    });
    const cases = await db
      .selectFrom('text_scan_test_case')
      .selectAll()
      .where('set_id', '=', String(pinned))
      .orderBy('entity_id')
      .execute();
    expect(cases.map((c) => [Number(c.entity_id), c.expected, c.origin])).toEqual([
      [11, { 'model-com-face-intent': true }, 'import'],
      [12, { 'model-com-face-intent': false }, 'import'],
      [13, {}, 'import'],
    ]);
    for (const c of cases) expect(c.fields).toEqual(LISTING);
    expect(
      await importIntentCases(
        { db, compose },
        pinned,
        [{ modelId: 12, expected: { 'model-com-face-intent': true } }],
        MOD
      )
    ).toEqual({ created: 0, updated: 1, notFound: [] });
  });

  it('refuses any other set', async () => {
    await expect(
      importIntentCases({ db, compose }, other, [{ modelId: 11, expected: {} }], MOD)
    ).rejects.toMatchObject({ status: 409 });
    expect(compose).not.toHaveBeenCalled();
  });
});

describe('parseIntentRows', () => {
  it('refuses the whole paste on a bad line or a repeated model', () => {
    expect(parseIntentRows('11 detected\n11 clear')).toMatch(/listed twice/);
    expect(parseIntentRows('11 maybe')).toMatch(/Line 1/);
    expect(parseIntentRows('\n# nothing\n')).toMatch(/at least one/);
  });
});
