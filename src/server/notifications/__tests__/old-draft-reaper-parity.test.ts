import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('~/utils/storage-resolver', () => ({
  deregisterFileLocationsBatch: vi.fn(() => Promise.resolve({ deleted: 0 })),
}));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { removeOldDrafts } from '~/server/jobs/remove-old-drafts';
import { modelNotifications } from '~/server/notifications/model.notifications';
import {
  OLD_DRAFT_LEAD_DAYS,
  OLD_DRAFT_LEAD_TEXT,
  OLD_DRAFT_NOTICE_DAYS,
  REAP_AGE_DAYS,
} from '~/server/common/draft-reaping';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * SEAM GUARD between the `old-draft` notification and the reaper in
 * `src/server/jobs/remove-old-drafts.ts`.
 *
 * The notification promises "will be deleted in <lead>" and is
 * `toggleable: false`, so a model it EXCLUDES is a model destroyed with no
 * notice at all.
 *
 * 🔴 THE PROPERTY, stated with its exclusions — an earlier revision wrote it as
 * an absolute, and the absolute was false:
 *
 *     For a model in `Draft`, no term in the notification may exclude a model
 *     the reaper will destroy — EXCEPT the two named below.
 *
 *   1. `Deleted` models are out of scope by design (see the status test).
 *   2. `downloadCount` is an ASSUMPTION, not a property (see the value-term
 *      block); it can decrease, and the band gives no second evaluation.
 *
 * Warning a model the reaper later spares is fine. Failing to warn one it
 * destroys is the bug.
 *
 * 🔴 WHY THE NOTIFICATION HAS NO ACTIVITY FENCE, and why this file guards the
 * SHAPE of the query rather than its parity with the reaper. Two revisions of
 * this PR mirrored the reaper's `NOT EXISTS` activity clauses and both were
 * wrong, because the two queries are evaluated on different schedules:
 *
 *   - the reaper is a nightly cron that RETRIES FOREVER, so it fires at
 *     `max(U + REAP_AGE_DAYS, activity + ACTIVITY_WINDOW_DAYS)`;
 *   - this notification evaluates ONCE, in a ~1-minute band at
 *     `U + OLD_DRAFT_NOTICE_DAYS`, and is never re-evaluated for that `U`.
 *
 * Worked example, with the model row last written Jan 1 and its version+file
 * landing Jan 3 — which `remove-old-drafts.ts` documents as the NORM: the
 * notification runs Jan 24 with a cutoff of Jan 1, sees activity on Jan 3,
 * excludes the model, and never looks again. The reaper first fires Feb 3 with a
 * cutoff of Jan 4, its fence clears, and the model is cascade-deleted unwarned.
 * No choice of interval fixes a predicate evaluated at one instant against a
 * condition that keeps moving, which is why the rule below is "no activity term
 * at all" rather than "the right interval".
 *
 * 🔴 AND WHY THE RULE IS AN ALLOWLIST. A previous revision expressed it as three
 * DENIALS — no `now()`-relative comparison, no `NOT EXISTS`, no reference to
 * `"ModelVersion"`/`"ModelFile"`. All three are spellings, and a deny-list of
 * spellings is unbounded by construction. Measured: this fence passed all of
 * them, because `<=` puts `=` where the regex wants a space and it reads a
 * column on a table the guards whitelisted —
 *
 *     AND (mm."lastVersionAt" IS NULL
 *       OR mm."lastVersionAt" <= now() - INTERVAL '23 days')
 *
 * — and it is a genuine activity fence: `ModelMetric."lastVersionAt"` is a real
 * maintained column. Two cruder rewrites (`NOT (EXISTS (…`, `0 = (SELECT count(*)
 * …`) also survived. The table and column allowlists below are CLOSED: any term
 * the query does not already have fails until someone adds it deliberately.
 */

/** `--` comments stripped, whitespace collapsed. Both sources carry `--` comments. */
function executable(sql: string) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The reaper's replica SELECT, as actually handed to Prisma. */
async function reaperSql() {
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
  await (removeOldDrafts as unknown as () => Promise<void>)();
  const [strings] = dbMock.dbRead.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
  return executable(strings.join('?'));
}

type Def = { prepareQuery?: (args: { lastSent: string }) => string };
type MessageDef = Def & {
  prepareMessage?: (args: { details: Record<string, unknown> }) => { message: string };
};

function notificationDef(source: typeof modelNotifications = modelNotifications) {
  const def = (source as unknown as Record<string, MessageDef>)['old-draft'];
  expect(def?.prepareQuery, 'the old-draft notification no longer builds a query').toBeTypeOf(
    'function'
  );
  return def;
}

function notificationSql() {
  return executable(notificationDef().prepareQuery!({ lastSent: '2026-01-01' }));
}

/** Quoted table names in FROM/JOIN position. */
function tablesReferenced(sql: string): string[] {
  return [...new Set([...sql.matchAll(/\b(?:FROM|JOIN)\s+"(\w+)"/gi)].map((m) => m[1]))].sort();
}

/** Every alias-qualified column reference, quoted or bare. */
function columnRefs(sql: string): string[] {
  return [
    ...new Set(
      [...sql.matchAll(/\b(\w+)\.(?:"(\w+)"|(\w+))/g)].map((m) => `${m[1]}.${m[2] ?? m[3]}`)
    ),
  ].sort();
}

/** The literals of a `<alias>.status IN (…)` clause. */
function statusSet(sql: string): string[] {
  const m = sql.match(/\bm\.status IN \(([^)]*)\)/);
  return m
    ? m[1]
        .split(',')
        .map((s) => s.trim().replace(/'/g, ''))
        .sort()
    : [];
}

/** The notification's firing band: `BETWEEN … - INTERVAL 'N days' AND NOW() - INTERVAL 'N days'`. */
function noticeBandDays(sql: string): number[] {
  return [...sql.matchAll(/INTERVAL '(\d+) days' AND NOW\(\) - INTERVAL '(\d+) days'/g)].flatMap(
    (m) => [Number(m[1]), Number(m[2])]
  );
}

/** The reaper's abandonment threshold: `m."updatedAt" < now() - INTERVAL 'N days'`. */
function reapAgeDays(sql: string): number | undefined {
  const m = sql.match(/m\."updatedAt" < now\(\) - INTERVAL '(\d+) days'/);
  return m ? Number(m[1]) : undefined;
}

/**
 * 🔴 CLOSED allowlists. Adding an entry is the deliberate act that lets a new
 * term into this query, and the reviewer's cue to ask whether that term can
 * exclude a model the reaper will destroy.
 */
const ALLOWED_TABLES = ['Model', 'ModelMetric'];
const ALLOWED_COLUMN_REFS = [
  'm.availability',
  'm.id',
  'm.name',
  'm.status',
  'm.updatedAt',
  'm.userId',
  'mm.downloadCount',
  'mm.modelId',
];

/**
 * Value terms — no time component, so they mean the same thing whenever they are
 * evaluated. These ARE required on both sides.
 */
const SHARED_VALUE_TERMS = [
  `m."availability" != 'Private'::"Availability"`,
  `mm."downloadCount" < 10`,
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('old-draft notification excludes a reapable model only via its named exclusions', () => {
  // POSITIVE CONTROL. Both sides must be real, distinct, non-empty SQL over
  // "Model", or every assertion below is satisfied by two empty strings.
  it('reads a real, distinct query from each side', async () => {
    const reaper = await reaperSql();
    const notification = notificationSql();

    expect(reaper, 'the reaper SELECT was not captured').toContain('FROM "Model" m');
    expect(notification, 'the notification SELECT was not captured').toContain('FROM "Model" m');
    expect(reaper.length).toBeGreaterThan(200);
    expect(notification.length).toBeGreaterThan(200);
    expect(notification).not.toBe(reaper);
  });

  describe('🔴 the closed allowlist', () => {
    // POSITIVE CONTROL for both extractors. A regex that silently stops matching
    // would otherwise turn every allowlist assertion into "[] equals []".
    it('extracts a non-empty table and column set', () => {
      const sql = notificationSql();

      expect(tablesReferenced(sql), 'the table extractor matched nothing').toContain('Model');
      expect(columnRefs(sql), 'the column extractor matched nothing').toContain('m.updatedAt');
      expect(columnRefs(sql).length).toBeGreaterThan(4);
    });

    it('reads exactly the allowed tables', () => {
      expect(
        tablesReferenced(notificationSql()),
        'a table outside the allowlist is almost certainly an activity fence: ModelVersion/ModelFile rows land AFTER the model row is last written, so a clause over them excludes exactly the models the reaper is coming for. If you are adding one deliberately, prove it cannot exclude a reapable model first.'
      ).toEqual(ALLOWED_TABLES);
    });

    it('reads exactly the allowed columns', () => {
      expect(
        columnRefs(notificationSql()),
        'a column outside the allowlist may be time-varying — e.g. ModelMetric."lastVersionAt" is a real maintained column that turns this query into an activity fence without naming another table. Add it here only after proving it cannot exclude a model the reaper will destroy.'
      ).toEqual(ALLOWED_COLUMN_REFS);
    });

    // Secondary, and deliberately NOT the closure — kept because they name the
    // specific hazard in their failure message, which the allowlist cannot.
    it('carries no now()-relative comparison', () => {
      expect(
        [...notificationSql().matchAll(/(\w+)\."(\w+)"\s*[<>]=?\s*now\(\)/gi)].map(
          (m) => `${m[1]}."${m[2]}"`
        ),
        'a now()-relative activity clause is unsound here: this query runs once, the reaper retries until it fires, so the clause excludes models the reaper later destroys — permanently and silently'
      ).toEqual([]);
    });

    it('has no NOT EXISTS activity fence', () => {
      expect(
        (notificationSql().match(/NOT\s*\(?\s*EXISTS\s*\(/gi) ?? []).length,
        "the reaper's activity fences must NOT be mirrored here — they are the terms whose correctness depends on predicting when the reaper fires"
      ).toBe(0);
    });
  });

  describe('🔴 the named exclusions', () => {
    /**
     * The notification covers `Draft` only; the reaper also destroys `Deleted`.
     *
     * That divergence is DELIBERATE and is pinned here so it stays visible: a
     * user who deleted a model has already expressed the intent, so warning them
     * it is about to be deleted is not the same safety case as warning someone
     * whose abandoned draft is about to vanish. Widening this notification to
     * `Deleted` is a product decision, not a bug fix — do not do it to make this
     * test pass.
     */
    it('warns on Draft only, while the reaper also destroys Deleted', async () => {
      const notification = statusSet(notificationSql());
      const reaper = statusSet(await reaperSql());

      expect(notification, 'the notification is scoped to Draft').toEqual(['Draft']);
      expect(reaper, 'the reaper also destroys Deleted models').toEqual(['Deleted', 'Draft']);
      expect(
        reaper.filter((s) => !notification.includes(s)),
        'the only status the reaper destroys unwarned is Deleted, and that is deliberate — see this test'
      ).toEqual(['Deleted']);
    });
  });

  describe('the shared value terms', () => {
    /**
     * 🔴 `downloadCount` is an ASSUMPTION, not a property, and this is the one
     * term that can silently drop a model out of the warning.
     *
     * It has NO incrementing writer — every write is a full recompute
     * (`model.metrics.ts`, a `SUM` over surviving `ModelVersionMetric` rows) — so
     * it is decreasing-capable by construction. Concrete path: a Draft model
     * rolled up to 12 is excluded here at day 23. A version carrying 8 downloads
     * is then deleted; `deleteVersionById` calls `updateModelLastVersionAt`,
     * which early-returns when the model has no `Published` version — true for a
     * Draft — so `Model."updatedAt"` is NOT bumped and this band never re-arms
     * (its lower edge is `lastSent - notice`, so there is no second evaluation).
     * A later recompute yields 4, the reaper's `< 10` becomes true, and the model
     * is cascade-deleted unwarned.
     *
     * That is architectural: the band gives one evaluation. It is recorded rather
     * than fixed. `availability` has no such hazard — its only raw-SQL writer
     * (`entityAvailabilityUpdate`) sets `"updatedAt" = NOW()` in the same
     * statement, so a change re-arms the band.
     */
    it.each(SHARED_VALUE_TERMS)('the reaper spells %s', async (term) => {
      expect(
        await reaperSql(),
        'this term is in the shared ledger but the reaper no longer has it — remove it from SHARED_VALUE_TERMS, and from the notification'
      ).toContain(term);
    });

    it.each(SHARED_VALUE_TERMS)('the old-draft notification spells %s', (term) => {
      expect(
        notificationSql(),
        'without this term the notification warns models the reaper will never touch — the ~1,308 false alarms this predicate exists to prevent'
      ).toContain(term);
    });

    it('pins the reaper age literal to the shared constant', async () => {
      expect(
        reapAgeDays(await reaperSql()),
        'the reaper destroys on this literal; the notification derives its own schedule from the constant it must equal'
      ).toBe(REAP_AGE_DAYS);
    });
  });

  describe('the firing band and its derivation', () => {
    it('keeps its band on Model."updatedAt", derived from the reap age', () => {
      expect(
        noticeBandDays(notificationSql()),
        'the BETWEEN band must carry the same interval on both sides'
      ).toEqual([OLD_DRAFT_NOTICE_DAYS, OLD_DRAFT_NOTICE_DAYS]);
      expect(
        OLD_DRAFT_NOTICE_DAYS + OLD_DRAFT_LEAD_DAYS,
        'the warning must fire exactly one lead time before the earliest possible reap'
      ).toBe(REAP_AGE_DAYS);
    });

    it('states the lead in the message with the same constant it schedules on', () => {
      const { message } = notificationDef().prepareMessage!({
        details: { modelName: 'Fixture', modelId: 7 },
      });

      expect(
        message,
        'the copy must derive from OLD_DRAFT_LEAD_DAYS or it silently contradicts the schedule'
      ).toContain(`deleted in ${OLD_DRAFT_LEAD_TEXT}`);
    });

    /**
     * 🔴 MECHANICAL CONTROL for every "derives from the constant" claim.
     *
     * The assertions above compare against the constants' own CURRENT values —
     * `OLD_DRAFT_NOTICE_DAYS` is 23, `OLD_DRAFT_LEAD_TEXT` is "1 week" — so a
     * hardcoded literal satisfies them. Measured, not assumed: such mutants
     * SURVIVED the whole file before this existed. The only way to tell
     * derivation from coincidence is to feed a value the constant cannot equal
     * and watch the output move.
     */
    it('MOVES with the constants — a literal that merely equals them does not pass', async () => {
      vi.resetModules();
      vi.doMock('~/server/common/draft-reaping', () => ({
        REAP_AGE_DAYS: 30,
        ACTIVITY_WINDOW_DAYS: 30,
        OLD_DRAFT_LEAD_DAYS: 14,
        OLD_DRAFT_NOTICE_DAYS: 16,
        OLD_DRAFT_LEAD_TEXT: '2 weeks',
      }));

      try {
        const mod = await import('~/server/notifications/model.notifications');
        const def = (mod.modelNotifications as unknown as Record<string, MessageDef>)['old-draft'];

        const { message } = def.prepareMessage!({ details: { modelName: 'Fixture', modelId: 7 } });
        expect(message, 'the message copy is hardcoded, not derived').toContain(
          'deleted in 2 weeks'
        );
        expect(message, 'the message copy is hardcoded, not derived').not.toContain('1 week');

        const sql = executable(def.prepareQuery!({ lastSent: '2026-01-01' }));
        expect(
          noticeBandDays(sql),
          'the BETWEEN band is hardcoded, not derived — it happens to equal the constant today'
        ).toEqual([16, 16]);
      } finally {
        vi.doUnmock('~/server/common/draft-reaping');
        vi.resetModules();
      }
    });
  });
});
