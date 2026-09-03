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
 * `toggleable: false`, so it is not a hint — a model it EXCLUDES is a model
 * destroyed with no notice at all.
 *
 * 🔴 THE PROPERTY IS ONE-DIRECTIONAL, AND IT IS NOT PARITY.
 *
 *     No term in the notification may exclude a model the reaper will destroy.
 *
 * Warning a model the reaper later spares is fine. Failing to warn one it
 * destroys is the bug. Two earlier revisions of this PR asserted TWO-WAY parity
 * — that the notification mirror the reaper's terms — and both shipped a defect,
 * because mirroring a `now()`-relative clause into a query that runs at a
 * different time changes what the clause MEANS:
 *
 *   - round 2 copied the reaper's fences verbatim; they resolved a week early.
 *   - round 3 re-derived the interval assuming the reaper is a ONE-SHOT
 *     evaluation at `U + REAP_AGE_DAYS`. It is a nightly cron that RETRIES, so
 *     it really fires at `max(U, activity) + REAP_AGE_DAYS`. Any model whose
 *     version or file landed after its model row was last written — the norm —
 *     was still excluded, permanently, and reaped later unwarned.
 *
 * The fences are now GONE from the notification rather than re-tuned, and the
 * guards below pin that shape rather than a parity relation. `activityAt` is
 * parameterised precisely because a single fixture is what let round 3 through:
 * the old headline test pinned `activityAt = U`, the one offset at which the
 * broken predicate happened to be correct.
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

/** The notification's SELECT, as actually produced by its own prepareQuery. */
function notificationSql() {
  return executable(notificationDef().prepareQuery!({ lastSent: '2026-01-01' }));
}

/**
 * Every `now()`-relative comparison in a query, as `{ alias, column, days }`.
 *
 * Captures the interval rather than asserting it, so the tests can do arithmetic
 * on the numbers the query ACTUALLY carries instead of on numbers the test
 * assumes. Covers both `>` and `<`.
 */
function timeRelativeTerms(sql: string) {
  const out: { alias: string; column: string; op: string; days: number }[] = [];
  const re = /(\w+)\."(\w+)" ([<>]) now\(\) - INTERVAL '(\d+) days'/gi;
  for (const m of sql.matchAll(re))
    out.push({ alias: m[1], column: m[2], op: m[3], days: Number(m[4]) });
  return out;
}

/** The notification's firing band: `BETWEEN … - INTERVAL 'N days' AND NOW() - INTERVAL 'N days'`. */
function noticeBandDays(sql: string): number[] {
  return [...sql.matchAll(/INTERVAL '(\d+) days' AND NOW\(\) - INTERVAL '(\d+) days'/g)].flatMap(
    (m) => [Number(m[1]), Number(m[2])]
  );
}

/**
 * Value terms — no time component, so they mean the same thing whenever they are
 * evaluated. These ARE required on both sides, and textual comparison is the
 * right invariant for them.
 */
const SHARED_VALUE_TERMS = [
  `m."availability" != 'Private'::"Availability"`,
  `mm."downloadCount" < 10`,
];

/**
 * Activity offsets to exercise, relative to the model row's last write `U`.
 *
 * `U + 0` is the all-at-once draft. `U + 0.5` and `U + 2` are the offsets that
 * broke rounds 2 and 3 — the finished resource landing hours or days after the
 * model row, which `remove-old-drafts.ts` documents as the norm. `U + 20` and
 * `U + 40` push activity past the notification's own firing instant.
 */
const ACTIVITY_OFFSET_DAYS = [0, 0.5, 2, 20, 40];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('old-draft notification never excludes a model the reaper will destroy', () => {
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

  describe('🔴 the structural rule: no time-relative activity clause', () => {
    /**
     * THE GUARD THAT WOULD HAVE CAUGHT BOTH REGRESSIONS.
     *
     * The notification evaluates ONCE, in a ~1-minute band; the reaper retries
     * nightly until its condition holds. So a `now()`-relative clause over a
     * table whose rows can move — ModelVersion, ModelFile — asks the question at
     * an instant that has no fixed relationship to when the reaper will act. No
     * choice of interval fixes that, which is why the rule is "none", not "the
     * right one".
     *
     * The firing band on `Model."updatedAt"` is the deliberate exception: it is
     * the same column the reaper's own age threshold tests, so the two move
     * together. It is written as a `BETWEEN`, so it does not appear in
     * `timeRelativeTerms` at all and is pinned by its own test below.
     */
    it('carries no now()-relative comparison at all', () => {
      const terms = timeRelativeTerms(notificationSql());

      expect(
        terms.map((t) => `${t.alias}."${t.column}" ${t.op}`),
        'a now()-relative clause over ModelVersion/ModelFile is unsound here: this query runs once, the reaper retries until it fires, so the clause excludes models the reaper later destroys — permanently and silently. Do not re-add an activity fence; see the comment on the query. (The firing band on Model."updatedAt" is a BETWEEN and is pinned separately.)'
      ).toEqual([]);
    });

    it('has no NOT EXISTS activity fence at all', () => {
      expect(
        (notificationSql().match(/NOT EXISTS \(/g) ?? []).length,
        "the reaper's activity fences must NOT be mirrored here — they are the terms whose correctness depends on predicting when the reaper fires"
      ).toBe(0);
    });

    // Widest form of the same rule, and the one a reworded fence cannot walk
    // past: this query has no business reading the tables whose rows move after
    // the model row was last written. It needs "Model" and "ModelMetric" only.
    it('does not reference ModelVersion or ModelFile at all', () => {
      const sql = notificationSql();

      for (const table of ['"ModelVersion"', '"ModelFile"']) {
        expect(
          sql,
          `${table} rows land AFTER the model row is last written, so any clause over them excludes exactly the models the reaper is coming for`
        ).not.toContain(table);
      }
      // Positive control: the tables it SHOULD read are still there, so this is
      // not passing because the query went missing.
      expect(sql, 'the query must still read the tables it legitimately needs').toContain(
        '"ModelMetric"'
      );
    });

    // Guards the exception above: the one permitted time term is the age band,
    // and it must be the reaper's own column and the derived window.
    it('keeps its firing band on Model."updatedAt", derived from the reap age', () => {
      const sql = notificationSql();

      expect(
        noticeBandDays(sql),
        'the BETWEEN band must carry the same interval on both sides'
      ).toEqual([OLD_DRAFT_NOTICE_DAYS, OLD_DRAFT_NOTICE_DAYS]);
      expect(
        OLD_DRAFT_NOTICE_DAYS + OLD_DRAFT_LEAD_DAYS,
        'the warning must fire exactly one lead time before the earliest possible reap'
      ).toBe(REAP_AGE_DAYS);
    });
  });

  describe('🔴 the property, across activity offsets', () => {
    /**
     * Property test, deliberately NOT a single fixture.
     *
     * The reap instant is modelled as `max(U, activityAt) + REAP_AGE_DAYS`,
     * because the reaper is a nightly cron that retries: it cannot fire while its
     * own activity fence still sees recent work, so activity PUSHES the reap
     * later. Hardcoding `U + REAP_AGE_DAYS` — a one-shot reaper — is precisely
     * the modelling error that let round 3's defect through a green suite.
     *
     * For each offset: whatever time-relative terms the notification actually
     * carries are evaluated at the notification's firing instant, and the model
     * must not be excluded before the reaper destroys it.
     */
    it.each(ACTIVITY_OFFSET_DAYS)('warns a model whose activity lands at U + %s days', (offset) => {
      const U = 0;
      const activityAt = U + offset;
      const notifyAt = U + OLD_DRAFT_NOTICE_DAYS;
      // The reaper retries nightly, so activity postpones the reap.
      const reapAt = Math.max(U, activityAt) + REAP_AGE_DAYS;

      expect(
        notifyAt,
        `fixture is wrong at offset ${offset}: the warning must precede the reap, or the assertion below is vacuous`
      ).toBeLessThan(reapAt);

      for (const term of timeRelativeTerms(notificationSql())) {
        // Only activity terms can wrongly exclude; the Model age band is the
        // firing condition itself, not an exclusion.
        if (term.alias === 'm' && term.column === 'updatedAt') continue;

        const excluded = term.op === '>' && activityAt > notifyAt - term.days;
        expect(
          excluded,
          `${term.alias}."${term.column}" excludes a model whose activity is at U+${offset} — the reaper destroys it at U+${reapAt} and this is the only warning it would ever get. The reaper RETRIES, so activity moves the reap later; no fixed interval here can track it.`
        ).toBe(false);
      }
    });
  });

  describe('the shared value terms', () => {
    // These carry no time component, so they mean the same thing at day 23 and at
    // the reap: downloadCount is monotonically non-decreasing in practice, and
    // availability is NOT NULL with a Public default whose change writes the
    // Model row (bumping updatedAt, which re-arms this band). That is why these
    // may be mirrored when the fences may not.
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
      const ageTerm = timeRelativeTerms(await reaperSql()).find(
        (t) => t.alias === 'm' && t.column === 'updatedAt' && t.op === '<'
      );

      expect(
        ageTerm?.days,
        'the reaper destroys on this literal; the notification derives its own schedule from the constant it must equal'
      ).toBe(REAP_AGE_DAYS);
    });
  });

  describe('derivation', () => {
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
     * hardcoded literal satisfies them. Measured, not assumed: three such mutants
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
