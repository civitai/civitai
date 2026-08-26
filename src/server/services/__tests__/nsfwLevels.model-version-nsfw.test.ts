import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ModelVersion.nsfw` — a version flagged by its NAME.
 *
 * These assert on rendered SQL because the behaviour IS the SQL: there is no branch in
 * TypeScript to exercise. That is the same approach as `nsfwLevels.buffer-flag.test.ts`
 * beside this file, and it is chosen for the same reason.
 *
 * What each one protects is a revert that produces no error anywhere — a flag that stops
 * driving the level, a flagged version that starts dragging its whole model off the SFW
 * domain, or a model that keeps a stale level forever. All three are silent.
 */

// Stub @prisma/client so Prisma.sql / raw / join are callable at import time and render an
// inspectable shape. Mirrors the in-repo pattern (see nsfwLevels.buffer-flag.test.ts).
vi.mock('@prisma/client', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let out = '';
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < values.length) {
        const v = values[i] as { sql?: string } | undefined;
        // Primitives are inlined, not rendered as `?`. The level a branch assigns IS the
        // behaviour — with a placeholder here, swapping `nsfwBrowsingLevelsFlag` for `1`
        // leaves every assertion in this file green while a flagged version becomes
        // fully visible on the SFW site.
        if (v && typeof v === 'object' && typeof v.sql === 'string') out += v.sql;
        else out += String(v);
      }
    }
    return { sql: out, strings, values };
  };
  const raw = (s: string) => ({ sql: s, values: [] });
  const join = (values: unknown[], separator = ',') => ({
    sql: values.map(() => '?').join(separator),
    values,
  });
  const Prisma = new Proxy(
    { sql, raw, join, empty: { sql: '', values: [] }, validator: () => (x: unknown) => x },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        return {};
      },
    }
  );
  return new Proxy(
    { Prisma, PrismaClient: class PrismaClient {} },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        if (prop === '__esModule') return true;
        return {};
      },
    }
  );
});

const { queueUpdateMock } = vi.hoisted(() => ({ queueUpdateMock: vi.fn() }));

vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  bountiesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  comicsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: queueUpdateMock },
}));

vi.mock('~/server/services/job-queue.service', () => ({
  enqueueJobs: vi.fn(() => Promise.resolve(undefined)),
}));

import {
  updateModelNsfwLevels,
  updateModelVersionNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const queryRaw = dbMock.dbWrite.$queryRaw;

const renderedSql = () => {
  const arg = queryRaw.mock.calls[0][0] as { sql?: string; strings?: readonly string[] };
  if (arg && typeof arg.sql === 'string') return arg.sql;
  if (arg && Array.isArray(arg.strings)) return arg.strings.join(' ');
  return JSON.stringify(arg);
};

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.sysRedis.hGet.mockResolvedValue(null);
  queryRaw.mockResolvedValue([]);
});

describe('updateModelVersionNsfwLevels — the flag drives the level', () => {
  it('treats mv.nsfw as an input to the derived level, beside m.nsfw', async () => {
    await updateModelVersionNsfwLevels([1]);
    // The whole design rests on this: because the flag is an INPUT, a recompute cannot
    // clobber it, which is why ModelVersion needs no lockedProperties column. Drop this
    // clause and the flag becomes decorative — every recompute overwrites it from images.
    expect(renderedSql()).toContain(
      `m.nsfw = TRUE OR mv.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}`
    );
  });

  it('queues the parent models for re-index', async () => {
    queryRaw.mockResolvedValue([
      { id: 10, modelId: 1 },
      { id: 11, modelId: 1 },
      { id: 12, modelId: 2 },
    ]);

    await updateModelVersionNsfwLevels([10, 11, 12]);

    // Deduped by model, not one call per version.
    expect(queueUpdateMock).toHaveBeenCalledTimes(1);
    expect(queueUpdateMock.mock.calls[0][0].map((x: { id: number }) => x.id)).toEqual([1, 2]);
  });

  it('does not queue an empty batch when no version level moved', async () => {
    queryRaw.mockResolvedValue([]);
    await updateModelVersionNsfwLevels([10]);
    expect(queueUpdateMock).not.toHaveBeenCalled();
  });
});

describe('updateModelNsfwLevels — a flagged version does not take the model down', () => {
  it('excludes flagged versions from the rollup', async () => {
    await updateModelNsfwLevels([1]);
    // Without the FILTER, one flagged version's level is bit_or'd into the model and the
    // whole model leaves the SFW domain — the outcome this feature exists to avoid.
    expect(renderedSql()).toContain('bit_or(mv."nsfwLevel") FILTER (WHERE NOT mv.nsfw)');
  });

  it('counts the unflagged versions so the all-flagged case is distinguishable', async () => {
    await updateModelNsfwLevels([1]);
    expect(renderedSql()).toContain('count(*) FILTER (WHERE NOT mv.nsfw)');
  });

  it('marks a model NSFW when every published version is flagged', async () => {
    await updateModelNsfwLevels([1]);
    // The VALUE, not just the branch. The filtered bit_or is NULL here, not 0, and the row
    // still exists — so without this branch the model keeps its old level forever; and with
    // the branch but the wrong level, it lands somewhere visible instead.
    expect(renderedSql()).toContain(`WHEN agg."safeCount" = 0 THEN ${nsfwBrowsingLevelsFlag}`);
  });

  it('still forces a write for an already-nsfw model', async () => {
    await updateModelNsfwLevels([1]);
    // Relied on by the moderation adapter: calling this on an already-correct nsfw row is
    // how it repairs a level and re-queues the search document.
    expect(renderedSql()).toContain('OR m.nsfw = TRUE');
  });
});

/**
 * `temp-set-missing-nsfw-level` carries its OWN copy of both rollups, scoped to rows sitting
 * at nsfwLevel 0, and runs every 10 minutes. It is reached by grepping for `bit_or`, not by
 * anything that links it to nsfwLevels.service — so a fix applied to one and not the other
 * looks complete and is silently undone on the next tick.
 *
 * Asserted as source text: the job builds its SQL from plain template literals with no
 * injection points, so there is no call to intercept and nothing to render.
 */
describe('temp-set-missing-nsfw-level — the second copy of the rollup', () => {
  const job = readFileSync(
    path.resolve(__dirname, '../../jobs/temp-set-missing-nsfw-level.ts'),
    'utf8'
  );

  it('excludes flagged versions from its model rollup', () => {
    // Without this, a model at level 0 with one flagged version has that version rolled up
    // here every 10 minutes — the exact outcome the service-side exclusion prevents.
    expect(job).toContain('bit_or(mv."nsfwLevel") FILTER (WHERE NOT mv.nsfw)');
  });

  // Pins the literal, and pins the DISAGREEMENT. This job writes 28 (R|X|XXX) where the
  // service writes nsfwBrowsingLevelsFlag (60, which adds Blocked) — a divergence that
  // predates this work and is deliberately left alone. Asserting both halves means whoever
  // reconciles them has to come here and say so, rather than the two copies drifting further.
  it('stamps its own literal level, still out of step with the service', () => {
    expect(job).toContain('WHEN agg."safeCount" = 0 THEN 28');
    expect(nsfwBrowsingLevelsFlag).toBe(60);
  });

  // Kept in step with the service so the two cannot diverge if this statement is ever revived.
  // It is NOT coverage of a live path: the version half of this job is pinned to a hardcoded id
  // and never references its own `missing_level` CTE, so the branch never executes. Asserted
  // together with that fact, so a reader cannot mistake this for a backstop that runs.
  it('keeps its dead version CASE in step with the service', () => {
    expect(job).toContain('m.nsfw = TRUE OR mv.nsfw = TRUE THEN 28');
    expect(job).toMatch(/WHERE mv\.id IN \(\d+\)/);
  });
});

describe('the ModelVersion nsfw trigger', () => {
  const root = path.resolve(__dirname, '../../../../packages/civitai-db-schema/prisma');
  const programmability = readFileSync(
    path.join(root, 'programmability/nsfw_level_update_triggers.sql'),
    'utf8'
  );
  const migration = readFileSync(
    path.join(root, 'migrations/20260824120000_model_version_nsfw/migration.sql'),
    'utf8'
  );

  // Migrations here are applied by hand and the programmability file is applied separately.
  // Nothing reconciles them, so a fix made in one and forgotten in the other is invisible
  // until an environment behaves differently from its own schema.
  it.each([
    ['programmability', () => programmability],
    ['migration', () => migration],
  ])('%s fires on nsfw as well as status', (_label, read) => {
    expect(read()).toContain('AFTER UPDATE OF "status", "nsfw" OR DELETE ON "ModelVersion"');
  });

  // Scoped to THIS function's body — the Model trigger in the same file carries its own
  // `IS DISTINCT FROM OLD."nsfw"` with a legitimate conjunct.
  const versionFn = (sql: string) =>
    sql.match(
      /CREATE OR REPLACE FUNCTION update_model_version_nsfw_level\(\)[\s\S]*?\$model_version_nsfw_level\$ LANGUAGE plpgsql;/
    )?.[0] ?? '';

  // Pins the WHOLE condition, not the presence of a substring. Narrowing it with any extra
  // conjunct — `AND NEW."nsfw"` is the obvious one — stops the clear from enqueueing, leaves
  // the version stamped, and freezes the model rollup, which is the documented incident
  // (20260519120000_fix_model_nsfw_flip_version_cascade). A `not.toMatch` on a hand-guessed
  // spelling of that bug cannot catch it; requiring the bare comparison can.
  it.each([
    ['programmability', () => programmability],
    ['migration', () => migration],
  ])('%s enqueues unconditionally inside the bare nsfw comparison', (_label, read) => {
    const fn = versionFn(read());
    // The WHOLE block, not the condition line. Constraining only the `IF` leaves a nested
    // `IF NEW."nsfw" THEN` around the PERFORM free to reintroduce the one-directional bug
    // with the condition line byte-identical.
    expect(fn).toMatch(
      /IF \(NEW\."nsfw" IS DISTINCT FROM OLD\."nsfw"\) THEN\s*PERFORM create_job_queue_record\(NEW\.id, 'ModelVersion', 'UpdateNsfwLevel'\);\s*END IF;/
    );
    // Kept beside the positive rather than replacing it — a conjunct on the condition and a
    // nested guard inside it are two different mutations.
    expect(fn).not.toMatch(/IS DISTINCT FROM OLD\."nsfw"[^)]/);
  });

  // Substring checks prove the two files share a few strings, not that they agree. The
  // migration is applied once by hand; the programmability file is the live definition. A
  // change made in one and forgotten in the other is invisible until an environment behaves
  // differently from its own schema.
  it('the two copies of the function body are identical', () => {
    const body = (sql: string) => versionFn(sql).replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();

    expect(body(programmability)).not.toEqual('');
    expect(body(migration)).toEqual(body(programmability));
  });

  it('enqueues the version, letting the cron derive the parent model', () => {
    expect(migration).toContain(
      `PERFORM create_job_queue_record(NEW.id, 'ModelVersion', 'UpdateNsfwLevel')`
    );
  });

  it('adds the column with a safe default so the migration is inert on arrival', () => {
    expect(migration).toContain(
      `ALTER TABLE "ModelVersion" ADD COLUMN IF NOT EXISTS "nsfw" BOOLEAN NOT NULL DEFAULT FALSE`
    );
  });

  // Applied by hand, so a partial apply has to be re-runnable from the top — and the concurrent
  // index is what makes a partial apply likely. Without IF NOT EXISTS the re-run dies on the
  // ALTER before it ever reaches the triggers.
  it('is re-runnable, and builds the concurrent index last', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS');
    expect(migration).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    // The statement, not the phrase — the top banner names it too.
    expect(
      migration.indexOf('CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModelVersion_modelId_nsfw_idx"')
    ).toBeGreaterThan(
      migration.indexOf('CREATE OR REPLACE TRIGGER model_version_nsfw_system_guard')
    );
  });

  // Keyed on modelId, NOT on nsfw. The partial predicate already pins every entry to the true
  // side, so keying on that column stores a constant: the index degenerates to an unordered tid
  // list and the planner ignores it for the per-model lookup entirely. This shape was reverted
  // once already and nothing caught it, because a wrong index is not a failing query — it is a
  // slow one nobody profiles.
  it('keys the partial index on modelId rather than on the predicate column', () => {
    expect(migration).toContain('ON "ModelVersion" ("modelId") WHERE "nsfw"');
    expect(migration).not.toMatch(/ON "ModelVersion" \("nsfw"\)/);
  });

  it('builds the index CONCURRENTLY, which cannot run inside a transaction', () => {
    expect(migration).toContain('CREATE INDEX CONCURRENTLY');
  });

  /**
   * A system-owned model's versions must never carry the flag. The derivation has no branch for
   * `userId = -1` with the flag off, so setting it there is one-way: clearing it leaves the
   * version stamped forever, and that rolls into the parent. Enforced at the write because the
   * adapter is not the only writer — a backfill or a moderator tool would not see an
   * application-side guard.
   */
  it.each([
    ['programmability', () => programmability],
    ['migration', () => migration],
  ])('%s refuses a system-owned write rather than silently dropping it', (_label, read) => {
    const sql = read();
    // RAISE, not a silent `NEW."nsfw" = false`. A bulk UPDATE that would strand rows should
    // abort loudly — a silent skip reports success and leaves the operator none the wiser.
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('m."userId" = -1');
  });

  it.each([
    ['programmability', () => programmability],
    ['migration', () => migration],
  ])('%s guards BEFORE the write, on INSERT as well as UPDATE', (_label, read) => {
    const sql = read();
    // BEFORE, or the row is already written by the time it raises.
    //
    // INSERT as well as UPDATE, because the writers this guard exists for are the ones that are
    // NOT the adapter — a backfill can INSERT a version with the flag already set, and an
    // UPDATE-only trigger never sees it. Once the row exists in that state no later UPDATE of
    // the column is needed to keep it, so there is no second chance.
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF "nsfw" ON "ModelVersion"');
    // The WHEN clause keeps the per-row EXISTS off the clear path and off other columns.
    expect(sql).toContain('WHEN (NEW."nsfw")');
  });
});

/**
 * The THIRD copy of the model rollup. Not on a timer, so it sits harmlessly — but a single
 * manual invocation reverses the exclusion for every model in its id range.
 */
describe('migrate-nsfwLevels — the third copy of the rollup', () => {
  const endpoint = readFileSync(
    path.resolve(__dirname, '../../../pages/api/admin/temp/migrate-nsfwLevels.ts'),
    'utf8'
  );

  it('excludes flagged versions', () => {
    expect(endpoint).toContain('bit_or(mv."nsfwLevel") FILTER (WHERE NOT mv.nsfw)');
  });

  it('has the all-flagged branch', () => {
    expect(endpoint).toContain('WHEN agg."safeCount" = 0 THEN');
  });

  // This file holds a VERSION rollup as well as the model one, and updating only the model half
  // is the mistake that was actually made here. Without the flag in the version CASE, running
  // the endpoint recomputes a flagged version's level from images alone — the stamp is wiped
  // while the flag stays set, and nothing re-stamps it.
  it('also carries the flag through its version rollup', () => {
    expect(endpoint).toContain('m.nsfw = TRUE OR mv.nsfw = TRUE');
  });

  // Once safeCount exists, an unflagged DRAFT suppresses the all-flagged fallback. The other two
  // copies have always filtered on Published; this one had not, and that omission changed from
  // harmless to load-bearing.
  it('counts only published versions, so a draft cannot suppress the fallback', () => {
    expect(endpoint).toContain(`AND mv.status = 'Published'`);
  });
});
