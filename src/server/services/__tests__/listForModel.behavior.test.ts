import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSchema,
  installPgliteQueryRaw,
  seedAppBlock,
  seedModel,
  seedModelVersion,
  seedPlatformDefault,
  seedSubscription,
  truncateAll,
} from './listForModel.harness';

// Spinning up the in-process PGlite (WASM Postgres) + schema in beforeAll, and
// the second PGlite in the bridge sanity test, can exceed the default 10s
// hook/test timeout on a slow / heavily-contended CI node (observed: the
// beforeAll hook timing out on the Tekton preview build pool, where this suite
// was the lone unit-test failure while it passes on faster GitHub runners).
// Generous, env-agnostic timeouts for this one PGlite-backed file — relaxing a
// timeout can only help a slow runner, never mask a real failure.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Behavioral tests for BlockRegistry.listForModel that run the REAL UNION-ALL
 * query against an in-process Postgres (PGlite). See listForModel.harness.ts
 * for why this exists and how the $queryRaw → PGlite bridge works.
 *
 * The happy-path / precedence tests lock in the currently-correct behavior and
 * MUST stay green. The bug-scenario tests assert the DESIRED behavior; where
 * the bug currently reproduces they are marked `it.fails(...)` (vitest: the
 * test passes when its body's assertion fails) so the suite stays green while
 * documenting the bug as a ready-to-flip tripwire.
 */

// --- hoisted mock holder -----------------------------------------------------
// A single mutable holder, created during hoisting, lets the (also-hoisted)
// vi.mock factories below reference a PGlite instance that we only assign in
// beforeAll — the factory closes over `holder`, not the instance.
const holder = vi.hoisted(() => {
  return { db: null as unknown as import('@electric-sql/pglite').PGlite };
});

vi.mock('~/server/db/client', () => ({
  dbRead: {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      // installPgliteQueryRaw is re-imported here (not the harness symbol) to
      // avoid pulling the harness module through the hoist boundary; the bridge
      // logic is tiny and identical.
      let sql = '';
      for (let i = 0; i < strings.length; i++) {
        sql += strings[i];
        if (i < values.length) sql += `$${i + 1}`;
      }
      return holder.db.query(sql, values as unknown[]).then((r) => r.rows);
    },
    modelVersion: { findMany: async () => [] },
  },
  dbWrite: {},
}));

vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: { get: async () => null, set: async () => undefined },
    get: async () => null,
    set: async () => undefined,
    del: async () => 0,
    scanIterator: async function* () {},
  },
  // Empty kill list → empty (non-sentinel) Set → nothing suppressed.
  sysRedis: { sMembers: async () => [] as string[] },
  REDIS_KEYS: {
    BLOCKS: { REGISTRY: 'packed:caches:block-registry', TOKEN_RATE_LIMIT: 'rl', REVOKED_INSTANCE: 'rev' },
  },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));

const SLOT = 'model.sidebar_top';
const OWNER = 100;
const VIEWER = 200;
const MODEL_ID = 5000;

// Standard manifests used across tests.
const manifestG = { targets: [{ slotId: SLOT }], contentRating: 'g' };
const manifestX = { targets: [{ slotId: SLOT }], contentRating: 'x' };

let db: PGlite;

// Sanity: prove the bridge fn the harness exports matches the inline one used
// in the mock (keeps the harness export covered + asserts the contract).
it('bridge: installPgliteQueryRaw reconstructs parameterized SQL', async () => {
  const tmp = new PGlite();
  await tmp.query('CREATE TABLE z (a int)');
  await tmp.query('INSERT INTO z VALUES (7)');
  const bridge = installPgliteQueryRaw(tmp);
  const strings = Object.assign(['SELECT a FROM z WHERE a = ', ''], {
    raw: ['SELECT a FROM z WHERE a = ', ''],
  }) as unknown as TemplateStringsArray;
  const rows = (await bridge(strings, 7)) as Array<{ a: number }>;
  expect(rows).toEqual([{ a: 7 }]);
});

beforeAll(async () => {
  db = new PGlite();
  holder.db = db;
  await createSchema(db);
});

beforeEach(async () => {
  await truncateAll(db);
});

async function listForModel(args: {
  modelId?: number;
  slotId?: string;
  modelType?: string;
  modelNsfwLevel?: number;
  viewerUserId?: number | null;
}) {
  const { BlockRegistry } = await import('../block-registry.service');
  return BlockRegistry.listForModel({
    modelId: args.modelId ?? MODEL_ID,
    slotId: args.slotId ?? SLOT,
    modelType: args.modelType,
    modelNsfwLevel: args.modelNsfwLevel ?? 8, // 'x' ceiling unless a test lowers it
    viewerUserId: args.viewerUserId,
  });
}

const ids = (rows: Array<{ blockInstanceId: string }>) => rows.map((r) => r.blockInstanceId);
const blockIds = (rows: Array<{ blockId: string }>) => rows.map((r) => r.blockId).sort();

// =============================================================================
// HAPPY-PATH / PRECEDENCE — these lock current correct behavior; keep green.
// =============================================================================
describe('listForModel precedence (locks current correct behavior)', () => {
  it('pinned subscription wins over blanket-publisher over platform-default (same app)', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedAppBlock(db, { id: 'ab_1', blockId: 'blk_1', manifest: manifestG });
    // rank-1 pinned
    await seedSubscription(db, {
      id: 'sub_pin',
      userId: OWNER,
      appBlockId: 'ab_1',
      scope: 'publisher_all_my_models',
      slotId: SLOT,
      targetModelIds: [MODEL_ID],
      blockInstanceId: 'bki_pinned',
    });
    // rank-2 blanket (same app, same owner) — should be suppressed by the pin
    await seedSubscription(db, {
      id: 'sub_blanket',
      userId: OWNER,
      appBlockId: 'ab_1',
      scope: 'publisher_all_my_models',
      slotId: null,
      targetModelIds: [],
      blockInstanceId: null,
    });
    // rank-3 platform default (same app) — should be suppressed by the pin
    await seedPlatformDefault(db, { appBlockId: 'ab_1', slotId: SLOT });

    const rows = await listForModel({});
    expect(ids(rows)).toEqual(['bki_pinned']);
  });

  it('blanket-publisher wins over platform-default when no pin (same app)', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedAppBlock(db, { id: 'ab_1', blockId: 'blk_1', manifest: manifestG });
    await seedSubscription(db, {
      id: 'sub_blanket',
      userId: OWNER,
      appBlockId: 'ab_1',
      scope: 'publisher_all_my_models',
      slotId: null,
      targetModelIds: [],
    });
    await seedPlatformDefault(db, { appBlockId: 'ab_1', slotId: SLOT });

    const rows = await listForModel({});
    // rank-2 blanket renders as bus_pub_<id>; rank-3 default for the SAME app
    // is NOT suppressed by a blanket (only a pin suppresses defaults), so it
    // also renders. Both present, blanket (rank 2) ordered first.
    expect(ids(rows)).toEqual(['bus_pub_sub_blanket', 'pdb_ab_1']);
  });

  it('platform-default renders when nothing else applies', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedAppBlock(db, { id: 'ab_1', blockId: 'blk_1', manifest: manifestG });
    await seedPlatformDefault(db, { appBlockId: 'ab_1', slotId: SLOT });

    const rows = await listForModel({});
    expect(ids(rows)).toEqual(['pdb_ab_1']);
  });

  it('viewer_personal renders only when no higher rank shows the same app', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedAppBlock(db, { id: 'ab_view', blockId: 'blk_view', manifest: manifestG });
    await seedAppBlock(db, { id: 'ab_default', blockId: 'blk_default', manifest: manifestG });
    // viewer sub for ab_view
    await seedSubscription(db, {
      id: 'sub_view',
      userId: VIEWER,
      appBlockId: 'ab_view',
      scope: 'viewer_personal',
      slotId: null,
      targetModelIds: [],
    });
    // platform default for a DIFFERENT app — should not suppress the viewer's app
    await seedPlatformDefault(db, { appBlockId: 'ab_default', slotId: SLOT });

    const rows = await listForModel({ viewerUserId: VIEWER });
    expect(ids(rows).sort()).toEqual(['bus_view_sub_view', 'pdb_ab_default'].sort());
  });

  it('viewer_personal is suppressed when a platform default shows the SAME app', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedAppBlock(db, { id: 'ab_1', blockId: 'blk_1', manifest: manifestG });
    await seedSubscription(db, {
      id: 'sub_view',
      userId: VIEWER,
      appBlockId: 'ab_1',
      scope: 'viewer_personal',
      slotId: null,
      targetModelIds: [],
    });
    await seedPlatformDefault(db, { appBlockId: 'ab_1', slotId: SLOT });

    const rows = await listForModel({ viewerUserId: VIEWER });
    // Only the platform default — viewer dup suppressed.
    expect(ids(rows)).toEqual(['pdb_ab_1']);
  });

  it('a normal pinned install + a blanket of a DIFFERENT app both render', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedAppBlock(db, { id: 'ab_pin', blockId: 'blk_pin', manifest: manifestG });
    await seedAppBlock(db, { id: 'ab_blanket', blockId: 'blk_blanket', manifest: manifestG });
    await seedSubscription(db, {
      id: 'sub_pin',
      userId: OWNER,
      appBlockId: 'ab_pin',
      scope: 'publisher_all_my_models',
      slotId: SLOT,
      targetModelIds: [MODEL_ID],
      blockInstanceId: 'bki_pin',
    });
    await seedSubscription(db, {
      id: 'sub_blanket',
      userId: OWNER,
      appBlockId: 'ab_blanket',
      scope: 'publisher_all_my_models',
      slotId: null,
      targetModelIds: [],
    });

    const rows = await listForModel({});
    expect(ids(rows).sort()).toEqual(['bki_pin', 'bus_pub_sub_blanket'].sort());
  });

  it('blanket type filter INCLUDES a matching model type', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedAppBlock(db, { id: 'ab_1', blockId: 'blk_1', manifest: manifestG });
    await seedSubscription(db, {
      id: 'sub_blanket',
      userId: OWNER,
      appBlockId: 'ab_1',
      scope: 'publisher_all_my_models',
      slotId: null,
      targetModelIds: [],
      targetModelTypes: ['LORA'],
    });

    const rows = await listForModel({ modelType: 'LORA' });
    expect(ids(rows)).toEqual(['bus_pub_sub_blanket']);
  });

  it('blanket type filter EXCLUDES a non-matching model type', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedAppBlock(db, { id: 'ab_1', blockId: 'blk_1', manifest: manifestG });
    await seedSubscription(db, {
      id: 'sub_blanket',
      userId: OWNER,
      appBlockId: 'ab_1',
      scope: 'publisher_all_my_models',
      slotId: null,
      targetModelIds: [],
      targetModelTypes: ['Checkpoint'],
    });

    const rows = await listForModel({ modelType: 'LORA' });
    expect(rows).toEqual([]);
  });

  it('blanket base-model filter INCLUDES when a version matches', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedModelVersion(db, { id: 9001, modelId: MODEL_ID, baseModel: 'SDXL 1.0' });
    await seedAppBlock(db, { id: 'ab_1', blockId: 'blk_1', manifest: manifestG });
    await seedSubscription(db, {
      id: 'sub_blanket',
      userId: OWNER,
      appBlockId: 'ab_1',
      scope: 'publisher_all_my_models',
      slotId: null,
      targetModelIds: [],
      targetBaseModels: ['SDXL 1.0'],
    });

    const rows = await listForModel({});
    expect(ids(rows)).toEqual(['bus_pub_sub_blanket']);
  });

  it('blanket base-model filter EXCLUDES when no version matches', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedModelVersion(db, { id: 9001, modelId: MODEL_ID, baseModel: 'SD 1.5' });
    await seedAppBlock(db, { id: 'ab_1', blockId: 'blk_1', manifest: manifestG });
    await seedSubscription(db, {
      id: 'sub_blanket',
      userId: OWNER,
      appBlockId: 'ab_1',
      scope: 'publisher_all_my_models',
      slotId: null,
      targetModelIds: [],
      targetBaseModels: ['SDXL 1.0'],
    });

    const rows = await listForModel({});
    expect(rows).toEqual([]);
  });

  it('content-rating filter drops an over-rated block on a low-nsfw model', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedAppBlock(db, { id: 'ab_g', blockId: 'blk_g', manifest: manifestG });
    await seedAppBlock(db, { id: 'ab_x', blockId: 'blk_x', manifest: manifestX });
    await seedPlatformDefault(db, { appBlockId: 'ab_g', slotId: SLOT, priority: 0 });
    await seedPlatformDefault(db, { appBlockId: 'ab_x', slotId: SLOT, priority: 1 });

    // nsfw level 1 => 'pg' ceiling; the 'x' block must be dropped in JS.
    const rows = await listForModel({ modelNsfwLevel: 1 });
    expect(blockIds(rows)).toEqual(['blk_g']);
  });
});

// =============================================================================
// BUG SCENARIOS — assert DESIRED behavior. Marked it.fails where the bug
// currently reproduces, so the suite stays green while flagging the gap.
// =============================================================================
describe('listForModel suppressor-gap bugs (assert desired behavior)', () => {
  // H2 FIXED 2026-05-31: the rank-1 SELECT + the rank-2/3/4 NOT EXISTS
  // suppressors now re-check the pinned row's own target_model_types /
  // target_base_models, so a non-applicable pin neither renders nor
  // suppresses. (Was `it.fails` while the bug reproduced.)
  it(
    'H2: a type-filtered pin that does NOT match this model must NOT suppress the blanket',
    async () => {
      await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
      await seedAppBlock(db, { id: 'ab_1', blockId: 'blk_1', manifest: manifestG });
      // A PINNED row whose own type filter says "Checkpoint only" — but this
      // model is a LORA, so per its own filters the pin does NOT apply here.
      await seedSubscription(db, {
        id: 'sub_pin_filtered',
        userId: OWNER,
        appBlockId: 'ab_1',
        scope: 'publisher_all_my_models',
        slotId: SLOT,
        targetModelIds: [MODEL_ID],
        targetModelTypes: ['Checkpoint'],
        blockInstanceId: 'bki_pinned_filtered',
      });
      // Blanket-publisher sub for the same app+owner — SHOULD render because
      // the pin doesn't actually apply to this LORA model.
      await seedSubscription(db, {
        id: 'sub_blanket',
        userId: OWNER,
        appBlockId: 'ab_1',
        scope: 'publisher_all_my_models',
        slotId: null,
        targetModelIds: [],
      });

      const rows = await listForModel({ modelType: 'LORA' });
      // DESIRED: blanket renders (pin's own filter excludes this model, so the
      // pin's rank-1 SELECT returns nothing AND it must not suppress rank-2).
      expect(ids(rows)).toEqual(['bus_pub_sub_blanket']);
    }
  );

  // H2 FIXED 2026-05-31 — same fix covers the rank-3 platform default path.
  it(
    'H2: a type-filtered pin that does NOT match this model must NOT suppress the platform default',
    async () => {
      await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
      await seedAppBlock(db, { id: 'ab_1', blockId: 'blk_1', manifest: manifestG });
      await seedSubscription(db, {
        id: 'sub_pin_filtered',
        userId: OWNER,
        appBlockId: 'ab_1',
        scope: 'publisher_all_my_models',
        slotId: SLOT,
        targetModelIds: [MODEL_ID],
        targetModelTypes: ['Checkpoint'],
        blockInstanceId: 'bki_pinned_filtered',
      });
      await seedPlatformDefault(db, { appBlockId: 'ab_1', slotId: SLOT });

      const rows = await listForModel({ modelType: 'LORA' });
      // DESIRED: platform default renders; the non-applicable pin must not
      // blank the slot.
      expect(ids(rows)).toEqual(['pdb_ab_1']);
    }
  );

  // H2b RE-ANALYSED 2026-05-31: NOT a bug — corrected from an it.fails.
  // The rank-2/3 NOT EXISTS suppressors are keyed on app_block_id, so a pin
  // only ever suppresses its OWN app's blanket/default — which carries the
  // SAME manifest + content rating. If the pin is dropped by the content-
  // rating filter (the app is too mature for this model), the same-app
  // fallback is equally over-rated and correctly absent too. An empty slot
  // is the RIGHT outcome here: pinning must not bypass content rating. (A
  // DIFFERENT, lower-rated app is never suppressed — see the control below.)
  it(
    'H2b: a same-app over-rated pin correctly yields an empty slot (pinning does not bypass content rating)',
    async () => {
      await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
      // Single app block, x-rated. Both the pin and the platform default point
      // at it.
      await seedAppBlock(db, { id: 'ab_x', blockId: 'blk_x', manifest: manifestX });
      // Pinned sub for THIS app on THIS model — suppresses the rank-3 default
      // in SQL (NOT EXISTS keyed on app_block_id).
      await seedSubscription(db, {
        id: 'sub_pin',
        userId: OWNER,
        appBlockId: 'ab_x',
        scope: 'publisher_all_my_models',
        slotId: SLOT,
        targetModelIds: [MODEL_ID],
        blockInstanceId: 'bki_pin_x',
      });
      // Platform default for the SAME app — suppressed in SQL by the pin, then
      // the only surviving row (the pin) is dropped by the JS content-rating
      // filter on a low-nsfw model → empty slot.
      await seedPlatformDefault(db, { appBlockId: 'ab_x', slotId: SLOT });

      // Low-nsfw model: 'pg' ceiling. rank-1 pin (x-rated) survives SQL but is
      // dropped by the JS content-rating filter; rank-3 default (also x-rated
      // here, but the point is the suppression) was already removed in SQL.
      const rows = await listForModel({ modelNsfwLevel: 1 });
      // CORRECT: an x-rated app must not show on a pg model whether it's
      // pinned or defaulted — both point at the same over-rated app_block,
      // so the empty slot is the intended content-rating behavior, not a gap.
      expect(rows).toEqual([]);
    }
  );

  // CONTROL (green): the H2b empty-slot only happens for a SAME-app fallback.
  // A DIFFERENT-app g-rated blanket survives even when an x-rated pin is
  // dropped by the content filter, because the rank-2 suppressor is keyed on
  // app_block_id. Documents that H2b did NOT reproduce in the cross-app shape.
  it('H2b control: a DIFFERENT-app g-rated blanket survives an x-rated pin dropped by the content filter', async () => {
    await seedModel(db, { id: MODEL_ID, ownerUserId: OWNER });
    await seedAppBlock(db, { id: 'ab_pin_x', blockId: 'blk_pin_x', manifest: manifestX });
    await seedAppBlock(db, { id: 'ab_blanket_g', blockId: 'blk_blanket_g', manifest: manifestG });
    await seedSubscription(db, {
      id: 'sub_pin',
      userId: OWNER,
      appBlockId: 'ab_pin_x',
      scope: 'publisher_all_my_models',
      slotId: SLOT,
      targetModelIds: [MODEL_ID],
      blockInstanceId: 'bki_pin_x',
    });
    await seedSubscription(db, {
      id: 'sub_blanket',
      userId: OWNER,
      appBlockId: 'ab_blanket_g',
      scope: 'publisher_all_my_models',
      slotId: null,
      targetModelIds: [],
    });

    const rows = await listForModel({ modelNsfwLevel: 1 });
    expect(ids(rows)).toEqual(['bus_pub_sub_blanket']);
  });
});
