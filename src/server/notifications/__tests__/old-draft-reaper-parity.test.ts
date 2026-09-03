import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('~/utils/storage-resolver', () => ({
  deregisterFileLocationsBatch: vi.fn(() => Promise.resolve({ deleted: 0 })),
}));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { removeOldDrafts } from '~/server/jobs/remove-old-drafts';
import { modelNotifications } from '~/server/notifications/model.notifications';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * SEAM GUARD between two files that independently spell ONE rule: which old
 * Draft models `remove-old-drafts` will actually destroy.
 *
 * The `old-draft` notification tells a creator their model "will be deleted in 1
 * week" and is `toggleable: false`, so it is not a hint — it is a promise, and it
 * is only true if this query selects the same population the reaper does. Until
 * 2026-09 it carried only the status and age terms, so it would have promised
 * deletion for every old Draft including the ones the reaper cannot touch.
 *
 * 🔴 The rule is open-coded in two places, which is the defect class that
 * regenerates itself. They are deliberately NOT one shared SQL string: the reaper
 * spells the download term as an INNER `JOIN "ModelMetric"` and the notification
 * as an `EXISTS`, and their age windows differ on purpose (23 days vs 30). This
 * guard is what stands in for the constant they cannot share.
 *
 * How the seam actually holds, which is a two-guard relationship and not this
 * file alone: `remove-old-drafts.test.ts` pins the reaper's WHOLE predicate as an
 * exact string, so ANY change to the reaper goes red there first and a human has
 * to look. This file is what then tells them the notification has to move too.
 *
 * ⚠ WHAT THIS CANNOT SEE, stated so nobody reads it as wider than it is: it pins
 * the terms named in `SHARED_TERMS` plus the structural counts below. A new term
 * added to the reaper that is neither a `NOT EXISTS` fence nor a 30-day interval
 * — say `AND m."userId" != -1` — moves no count here and is covered by no ledger
 * entry, so only the whole-predicate pin in `remove-old-drafts.test.ts` would
 * catch it. If you add one, add it to `SHARED_TERMS` too.
 */

/**
 * Every term the two queries must spell identically. The aliases are chosen to
 * match on both sides (`mm`, `mv`, `mv2`, `mf`) precisely so this comparison can
 * be textual.
 *
 * The 23-day notification window and the 30-day reaper age threshold are NOT
 * here, and must not be: they are different quantities on purpose. The
 * notification fires a week early — that is the whole point of it.
 */
const SHARED_TERMS = [
  `m."availability" != 'Private'::"Availability"`,
  `mm."downloadCount" < 10`,
  `mv."createdAt" > now() - INTERVAL '30 days'`,
  `mv."updatedAt" > now() - INTERVAL '30 days'`,
  `mf."createdAt" > now() - INTERVAL '30 days'`,
];

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

/** The notification's SELECT, as actually produced by its own prepareQuery. */
function notificationSql() {
  const def = (modelNotifications as unknown as Record<string, Def>)['old-draft'];
  expect(def?.prepareQuery, 'the old-draft notification no longer builds a query').toBeTypeOf(
    'function'
  );
  return executable(def!.prepareQuery!({ lastSent: '2026-01-01' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('old-draft notification tracks the remove-old-drafts reaper', () => {
  // POSITIVE CONTROL. Both sides must be real, non-empty SQL over "Model", or
  // every parity assertion below is satisfied by two empty strings.
  it('reads a real query from each side', async () => {
    const reaper = await reaperSql();
    const notification = notificationSql();

    expect(reaper, 'the reaper SELECT was not captured').toContain('FROM "Model" m');
    expect(notification, 'the notification SELECT was not captured').toContain('FROM "Model" m');
    expect(reaper.length).toBeGreaterThan(200);
    expect(notification.length).toBeGreaterThan(200);
    // Sanity that they are genuinely two different strings and not one source
    // read twice — a mistake that would make every term below trivially equal.
    expect(notification).not.toBe(reaper);
  });

  it.each(SHARED_TERMS)('the reaper spells %s', async (term) => {
    expect(
      await reaperSql(),
      'this term is in the shared ledger but the reaper no longer has it — remove it from SHARED_TERMS, and from the notification'
    ).toContain(term);
  });

  it.each(SHARED_TERMS)('the old-draft notification spells %s', (term) => {
    expect(
      notificationSql(),
      'the notification promises deletion in 1 week; a reapability term it does not carry makes that promise false'
    ).toContain(term);
  });

  // Catches the set GROWING on one side only — a new fence added to the reaper
  // and not mirrored here, which no per-term assertion above can see.
  it('carries the same number of activity fences on both sides', async () => {
    const reaper = await reaperSql();
    const notification = notificationSql();

    const fences = (sql: string) => (sql.match(/NOT EXISTS \(/g) ?? []).length;
    expect(fences(reaper), 'the reaper must still have both activity fences').toBe(2);
    expect(
      fences(notification),
      'a fence added to or removed from the reaper must be mirrored in the notification'
    ).toBe(fences(reaper));
  });

  it('carries the same number of 30-day intervals on both sides', async () => {
    const reaper = await reaperSql();
    const notification = notificationSql();

    const windows = (sql: string) => (sql.match(/INTERVAL '30 days'/g) ?? []).length;
    // 3 fence clauses on the notification side; the reaper adds its own age
    // threshold, which the notification deliberately does NOT share.
    expect(windows(notification), 'the three fence clauses must all be present').toBe(3);
    expect(
      windows(reaper),
      'the reaper carries the same three fence clauses plus its own age threshold'
    ).toBe(windows(notification) + 1);
  });

  // The notification's own window is the one thing that must NOT track the
  // reaper: it fires a week early on purpose.
  it('keeps its own 23-day window, a week ahead of the reaper', () => {
    expect(
      (notificationSql().match(/INTERVAL '23 days'/g) ?? []).length,
      'the notification fires at day 23 so the warning arrives a week before the reaper acts'
    ).toBe(2);
  });
});
