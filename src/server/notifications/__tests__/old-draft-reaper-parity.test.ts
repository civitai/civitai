import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('~/utils/storage-resolver', () => ({
  deregisterFileLocationsBatch: vi.fn(() => Promise.resolve({ deleted: 0 })),
}));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { removeOldDrafts } from '~/server/jobs/remove-old-drafts';
import { modelNotifications } from '~/server/notifications/model.notifications';
import {
  ACTIVITY_WINDOW_DAYS,
  OLD_DRAFT_LEAD_DAYS,
  OLD_DRAFT_LEAD_TEXT,
  OLD_DRAFT_NOTICE_DAYS,
  REAP_AGE_DAYS,
} from '~/server/common/draft-reaping';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * SEAM GUARD between two queries that independently spell ONE rule: which old
 * Draft models `remove-old-drafts` will actually destroy.
 *
 * The `old-draft` notification tells a creator their model "will be deleted in
 * <lead>" and is `toggleable: false`, so it is not a hint — it is a promise, and
 * it is only true if this query selects the same population the reaper will.
 *
 * 🔴 THE INVARIANT IS THE RESOLVED WINDOW, NOT THE SOURCE TEXT — and getting that
 * wrong is not hypothetical, it shipped in this PR's own history. An earlier
 * revision of this file asserted the notification spelled the reaper's
 * `INTERVAL '30 days'` VERBATIM. That is the wrong invariant: the two queries run
 * `OLD_DRAFT_LEAD_DAYS` apart, so the same `now()`-relative text is a DIFFERENT
 * absolute window on each side. The textual guard passed while the notification's
 * fence resolved a week earlier than the reaper's, which silently excluded the
 * canonical abandoned draft from the warning and then let it be reaped. Worse, the
 * textual guard would have gone RED on the correct fix — a guard that blocks its
 * own repair. Everything below compares RESOLVED windows.
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

/** The notification's SELECT, as actually produced by its own prepareQuery. */
function notificationSql() {
  const def = (modelNotifications as unknown as Record<string, Def>)['old-draft'];
  expect(def?.prepareQuery, 'the old-draft notification no longer builds a query').toBeTypeOf(
    'function'
  );
  return executable(def!.prepareQuery!({ lastSent: '2026-01-01' }));
}

/**
 * The three activity-fence clauses, as `[alias.column, days]`.
 *
 * Matching on `> now() - INTERVAL 'N days'` deliberately captures N rather than
 * asserting it, so the tests below can do arithmetic on it. A fence written any
 * other way is not found, and the count assertions turn that into a failure
 * rather than a silent pass.
 */
function fenceWindows(sql: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /(\w+)\."(\w+)" > now\(\) - INTERVAL '(\d+) days'/g;
  for (const m of sql.matchAll(re)) out[`${m[1]}."${m[2]}"`] = Number(m[3]);
  return out;
}

/** The reaper's own abandonment threshold: `m."updatedAt" < now() - INTERVAL 'N days'`. */
function reapAgeDays(sql: string): number | undefined {
  const m = sql.match(/m\."updatedAt" < now\(\) - INTERVAL '(\d+) days'/);
  return m ? Number(m[1]) : undefined;
}

/** The notification's firing band: `BETWEEN … - INTERVAL 'N days' AND NOW() - INTERVAL 'N days'`. */
function noticeBandDays(sql: string): number[] {
  return [...sql.matchAll(/INTERVAL '(\d+) days' AND NOW\(\) - INTERVAL '(\d+) days'/g)].flatMap(
    (m) => [Number(m[1]), Number(m[2])]
  );
}

/** Terms that carry no interval, so textual comparison IS the right invariant. */
const SHARED_EXACT_TERMS = [
  `m."availability" != 'Private'::"Availability"`,
  `mm."downloadCount" < 10`,
];

const FENCE_KEYS = ['mv."createdAt"', 'mv."updatedAt"', 'mf."createdAt"'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('old-draft notification tracks the remove-old-drafts reaper', () => {
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

  describe('🔴 the resolved fence windows — the regression guard', () => {
    /**
     * THE GUARD THIS SEAM WAS MISSING.
     *
     * Simulates the canonical abandoned draft against the numbers the two queries
     * ACTUALLY carry: model row, version and file all last touched at `U`, then
     * abandoned. `remove-old-drafts.ts` describes this as the norm — "the finished
     * resource lands hours or weeks later" — and it is the population the reaper
     * exists to collect.
     *
     * With the defect (fences spelled 30) this test fails: the notification's
     * window resolves to `U - 7d`, activity at `U` is newer than that, the
     * `NOT EXISTS` is false, and the model is never warned — then reaped.
     */
    it('warns the canonical abandoned draft before the reaper destroys it', async () => {
      const reaper = await reaperSql();
      const notification = notificationSql();

      const U = 0;
      const DAY = 1;
      const notifyAt = U + OLD_DRAFT_NOTICE_DAYS * DAY;
      const reapAt = U + REAP_AGE_DAYS * DAY;

      // Every timestamp under the model sits at U — the abandoned case.
      const activityAt = U;

      const notifFences = fenceWindows(notification);
      const reaperFences = fenceWindows(reaper);

      for (const key of FENCE_KEYS) {
        expect(notifFences[key], `the notification lost its ${key} fence`).toBeTypeOf('number');
        expect(reaperFences[key], `the reaper lost its ${key} fence`).toBeTypeOf('number');

        const reaperSpares = activityAt > reapAt - reaperFences[key] * DAY;
        const notificationSkips = activityAt > notifyAt - notifFences[key] * DAY;

        expect(
          reaperSpares,
          `${key}: fixture is wrong — the reaper must DESTROY this model, or the assertion below is vacuous`
        ).toBe(false);
        expect(
          notificationSkips,
          `${key}: a model the reaper WILL destroy is excluded from the warning — it gets deleted with no notice. The fence interval must resolve to the reaper's window, so it is OLD_DRAFT_NOTICE_DAYS here, NOT the reaper's ${ACTIVITY_WINDOW_DAYS}.`
        ).toBe(false);
      }
    });

    it('resolves both sides to the same absolute instant', async () => {
      const reaper = await reaperSql();
      const notification = notificationSql();
      const notifFences = fenceWindows(notification);
      const reaperFences = fenceWindows(reaper);

      for (const key of FENCE_KEYS) {
        expect(
          OLD_DRAFT_NOTICE_DAYS - notifFences[key],
          `${key}: the notification fires ${OLD_DRAFT_LEAD_DAYS}d early, so its window must be shorter by exactly that much`
        ).toBe(REAP_AGE_DAYS - reaperFences[key]);
      }
    });

    it('derives the notice band from the reap age and the lead, on both intervals', () => {
      const band = noticeBandDays(notificationSql());

      expect(band, 'the BETWEEN band must carry the same interval on both sides').toEqual([
        OLD_DRAFT_NOTICE_DAYS,
        OLD_DRAFT_NOTICE_DAYS,
      ]);
      expect(
        OLD_DRAFT_NOTICE_DAYS + OLD_DRAFT_LEAD_DAYS,
        'the warning must fire exactly one lead time before the reap age'
      ).toBe(REAP_AGE_DAYS);
    });

    it('pins the reaper age literal to the shared constant', async () => {
      expect(
        reapAgeDays(await reaperSql()),
        'the reaper destroys on this literal; the notification derives its own schedule from the constant it must equal'
      ).toBe(REAP_AGE_DAYS);
    });

    it('states the lead in the message with the same constant it schedules on', () => {
      const def = (modelNotifications as unknown as Record<string, MessageDef>)['old-draft'];
      const { message } = def.prepareMessage!({ details: { modelName: 'Fixture', modelId: 7 } });

      expect(
        message,
        'the copy must derive from OLD_DRAFT_LEAD_DAYS or it silently contradicts the schedule'
      ).toContain(`deleted in ${OLD_DRAFT_LEAD_TEXT}`);
    });

    /**
     * 🔴 THE MECHANICAL CONTROL for every "derives from the constant" claim above.
     *
     * Those assertions compare the query and the copy against the constants' own
     * CURRENT values — `OLD_DRAFT_NOTICE_DAYS` is 23 and `OLD_DRAFT_LEAD_TEXT` is
     * "1 week" — so a hardcoded literal `23` or `"1 week"` satisfies every one of
     * them. Measured, not assumed: a mutant replacing the interpolation with the
     * literal `1 week` SURVIVED the whole file before this test existed.
     *
     * The only way to tell derivation from coincidence is to feed a value the
     * constant CANNOT currently equal and watch the output move. This re-imports
     * the module against a doubled lead, so every derived value changes: the copy
     * becomes "2 weeks" and the notice window becomes 16 days.
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
          Object.values(fenceWindows(sql)),
          'a fence interval is hardcoded, not derived — it happens to equal the constant today'
        ).toEqual([16, 16, 16]);
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

  describe('the shared reapability terms', () => {
    it.each(SHARED_EXACT_TERMS)('the reaper spells %s', async (term) => {
      expect(
        await reaperSql(),
        'this term is in the shared ledger but the reaper no longer has it — remove it from SHARED_EXACT_TERMS, and from the notification'
      ).toContain(term);
    });

    it.each(SHARED_EXACT_TERMS)('the old-draft notification spells %s', (term) => {
      expect(
        notificationSql(),
        'the notification promises deletion; a reapability term it does not carry makes that promise false'
      ).toContain(term);
    });

    // Catches the fence set GROWING or SHRINKING on one side only — neither the
    // per-term assertions nor the window arithmetic can see a fence that exists
    // on one side and not the other.
    it('carries the same fence columns on both sides', async () => {
      const reaperKeys = Object.keys(fenceWindows(await reaperSql())).sort();
      const notifKeys = Object.keys(fenceWindows(notificationSql())).sort();

      expect(reaperKeys, 'the reaper must still carry exactly the known fences').toEqual(
        [...FENCE_KEYS].sort()
      );
      expect(
        notifKeys,
        'a fence added to or removed from the reaper must be mirrored in the notification'
      ).toEqual(reaperKeys);
    });

    it('carries the same number of NOT EXISTS fences on both sides', async () => {
      const fences = (sql: string) => (sql.match(/NOT EXISTS \(/g) ?? []).length;

      expect(fences(await reaperSql()), 'the reaper must still have both activity fences').toBe(2);
      expect(
        fences(notificationSql()),
        'a fence added to or removed from the reaper must be mirrored in the notification'
      ).toBe(fences(await reaperSql()));
    });
  });
});
