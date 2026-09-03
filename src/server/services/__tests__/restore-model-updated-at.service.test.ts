import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelVersionService from '~/server/services/model-version.service';

/**
 * `restoreModelById` un-deletes a model with raw SQL, so Prisma's `@updatedAt`
 * does not fire and the restored row keeps the timestamp it carried while it was
 * deleted — the DELETION instant, since `deleteModelById` writes through the
 * Prisma client.
 *
 * 🔴 What that does and does NOT cause — the full reasoning, against the actual
 * predicate, is on `restoreModelById` itself; the short version, because three
 * earlier framings of it were wrong: `'Deleted'` is already in
 * `remove-old-drafts`' `status IN ('Draft','Deleted')` set, so the clock runs
 * while the model sits deleted, and restoring changes only `status`. The
 * post-restore candidate set is a strict SUBSET of the pre-restore one, so the
 * missing bump does not make a model reapable that was not already. It costs two
 * other things: a restored model keeps only the REMAINDER of its 30 days rather
 * than a fresh window (deleted day 0, restored day 29 -> reaped the night of day
 * 30/31), and — the stronger one — it is cascade-deleted UNWARNED, because the
 * `old-draft` notification warns on `Draft` only and evaluates its band once at
 * `U + OLD_DRAFT_NOTICE_DAYS`, which a carried-over `U` has already passed.
 *
 * Same defect class as the two sweep sites fixed in #4595, and the same fix.
 * `no-unbumped-draft-status-write.test.ts` holds all three sites to the rule as
 * source text; this file is the behavioural half for this one — it drives the
 * real `restoreModelById` and reads the statement it actually issues.
 *
 * Same import-the-real-model.service scaffold as
 * `model.service.transfer-paid-access-owner.test.ts`; only the I/O surfaces are
 * stubbed, and `~/server/db/client` uses the canonical `dbMock`.
 */

const MODEL_ID = 4711;
// Deliberately distinct from MODEL_ID and from every literal asserted below, so
// a mutant cannot pass by landing on a constant one of them happens to equal.
const OWNER_USER_ID = 8302;

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: { cancellableQuery: vi.fn() },
  pgDbWrite: {},
  pgDbReadLong: {},
}));
vi.mock('~/server/services/model-file.service', () => ({
  getFilesForModelVersionCache: vi.fn(),
  deleteFilesForModelVersionCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn().mockResolvedValue({}),
  queueImageSearchIndexUpdate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(),
  getPublicPaidAccessForModelVersions: vi.fn().mockResolvedValue({}),
  bustPaidAccessCache: vi.fn(),
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  bustMvCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn().mockResolvedValue(new Map()),
  getUserMetricPrivacyDefaultsMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn().mockResolvedValue({}),
  getProfilePicturesForUsers: vi.fn().mockResolvedValue({}),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { fetch: vi.fn() },
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  modelTagCache: { fetch: vi.fn(), bust: vi.fn() },
  modelVotableTagsCache: { fetch: vi.fn(), bust: vi.fn() },
  userBasicCache: { fetch: vi.fn().mockResolvedValue({}), bust: vi.fn() },
  userModelCountCache: { fetch: vi.fn(), bust: vi.fn(), refresh: vi.fn() },
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {},
  Tracker: class {
    modelEvent = vi.fn();
  },
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import { restoreModelById } from '~/server/services/model.service';

const mockDbWrite = dbMock.dbWrite;

/**
 * Every raw statement the call issued, `--` comments stripped and whitespace
 * collapsed.
 *
 * 🔴 Stripping comments is not cosmetic. These are SPELLED guards over SQL
 * source, and a `--` comment is not a clause: a future
 * `-- also sets "updatedAt" = now()` beside the statement would satisfy the fix
 * guard below over SQL that does not do it.
 *
 * `$queryRaw` and `$executeRaw` are read together because the two statements in
 * this transaction use different methods (the Model one RETURNs, the
 * ModelVersion one does not) and every helper here selects by table name.
 *
 * ⚠ An approximation of what Postgres executes, not a SQL parser. A `--` inside
 * a quoted string literal is stripped here but is not a comment to the database.
 * Nothing in this function is near that shape.
 */
function issuedStatements(): string[] {
  return [...mockDbWrite.$queryRaw.mock.calls, ...mockDbWrite.$executeRaw.mock.calls].map(
    ([strings]) =>
      (strings as string[])
        .join(' ?? ')
        .replace(/--[^\n]*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
  );
}

/**
 * The single `UPDATE "Model"` statement.
 *
 * Asserting there is exactly one is the positive control for every guard built
 * on it: without it, a function that stopped issuing the statement — or a mock
 * wired to nothing — would satisfy them all by returning `undefined`.
 */
function modelUpdateSql(): string {
  const matches = issuedStatements().filter((sql) => sql.startsWith('UPDATE "Model" '));
  expect(matches, 'expected exactly one UPDATE "Model" statement to have been issued').toHaveLength(
    1
  );
  return matches[0];
}

/** The single `UPDATE "ModelVersion"` statement. */
function versionUpdateSql(): string {
  const matches = issuedStatements().filter((sql) => sql.startsWith('UPDATE "ModelVersion" '));
  expect(
    matches,
    'expected exactly one UPDATE "ModelVersion" statement to have been issued'
  ).toHaveLength(1);
  return matches[0];
}

/**
 * The `UPDATE "Model"` statement's SET clause as ordered `[target, value]` pairs.
 *
 * 🔴 Reading the assignments as a LIST is the point. A `toContain` guard can
 * only see a clause that was REMOVED; it is blind to one that was ADDED.
 * Injecting `"publishedAt" = now(),` here would pass every `toContain` in this
 * file — and `publishedAt` is exactly the column this function's own comment
 * says must not move, because a spurious bump would let the next publish reset
 * it under the legacy gate.
 *
 * Split on commas at paren depth 0 so a comma inside a function call cannot
 * fragment an assignment. The status CASE carries no parenthesised group today;
 * the depth tracking is what keeps that from becoming load-bearing.
 */
function modelSetAssignments(): [string, string][] {
  const sql = modelUpdateSql();
  // Anchored on the column the top-level WHERE opens on, not on the first
  // ` WHERE `, so a future subquery in the SET clause cannot silently truncate
  // this and make every assertion below read a fragment.
  const whereAt = sql.indexOf(' WHERE id = ');
  expect(
    whereAt,
    'could not locate the top-level WHERE; every SET-clause guard would be vacuous'
  ).toBeGreaterThan(0);
  const setAt = sql.indexOf(' SET ');
  expect(setAt, 'could not locate the SET clause').toBeGreaterThan(0);
  const setClause = sql.slice(setAt + ' SET '.length, whereAt);

  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of setClause) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  return parts.map((part) => {
    const eq = part.indexOf(' = ');
    expect(eq, `SET fragment is not an assignment: ${part.trim()}`).toBeGreaterThan(0);
    return [part.slice(0, eq).trim(), part.slice(eq + 3).trim()] as [string, string];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // A row must come back or `restoreModelById` returns null before the caches
  // are touched — and, more importantly, a run that restored nothing would be
  // the same green as a harness wired to nothing.
  mockDbWrite.$queryRaw.mockResolvedValue([{ userId: OWNER_USER_ID }]);
  mockDbWrite.$executeRaw.mockResolvedValue(1);
});

describe('restoreModelById', () => {
  it('restores the model and reports its owner', async () => {
    // POSITIVE CONTROL for the whole file: the function has to reach its
    // statements and return a restored model, or every guard below is a claim
    // about a code path that never ran.
    await expect(restoreModelById({ id: MODEL_ID })).resolves.toEqual({
      id: MODEL_ID,
      userId: OWNER_USER_ID,
    });
  });

  describe('the UPDATE "Model" statement', () => {
    // 🔴 THE FIX. See the file header: this statement is raw SQL, so
    // `@updatedAt` does not fire and a restored model lands in Draft still
    // carrying the clock it had when it was deleted.
    it('bumps "updatedAt" so a restored model gets a real grace period before the reaper', async () => {
      await restoreModelById({ id: MODEL_ID });

      expect(
        modelUpdateSql(),
        'without the bump a restored model keeps only the remainder of its 30 days before remove-old-drafts cascade-deletes it, and is deleted unwarned because the old-draft notification band for that carried-over timestamp has already passed'
      ).toContain('"updatedAt" = now()');
    });

    // The fix must be ADDITIVE. These pin the behaviour it sits next to, so a
    // change that satisfies the guard above by REPLACING the SET list rather
    // than extending it cannot pass.
    it('still clears the deletion columns', async () => {
      await restoreModelById({ id: MODEL_ID });

      const sql = modelUpdateSql();
      expect(sql, 'un-deleting is the point of this function').toContain('"deletedAt" = NULL');
      expect(sql).toContain('"deletedBy" = NULL');
    });

    it('still derives the restored status from publishedAt', async () => {
      await restoreModelById({ id: MODEL_ID });

      const sql = modelUpdateSql();
      expect(sql, 'the status CASE must survive the "updatedAt" bump').toContain('"status" = CASE');
      expect(sql).toContain(`WHEN "publishedAt" IS NULL THEN 'Draft'::"ModelStatus"`);
      expect(sql).toContain(`WHEN "publishedAt" > NOW() THEN 'Scheduled'::"ModelStatus"`);
      expect(sql).toContain(`ELSE 'Unpublished'::"ModelStatus"`);
    });

    it('still only touches a row that is actually Deleted', async () => {
      await restoreModelById({ id: MODEL_ID });

      // Without this predicate the bump alone would move `updatedAt` on a live
      // model — a write to every row the id matches, restored or not.
      expect(modelUpdateSql()).toContain(`AND "status" = 'Deleted'::"ModelStatus"`);
    });

    // 🔴 The ledger. Fails when the SET list GROWS as well as when it shrinks.
    it('writes exactly "deletedAt", "deletedBy", "status" and "updatedAt" — no other column', async () => {
      await restoreModelById({ id: MODEL_ID });

      expect(
        modelSetAssignments().map(([target]) => target),
        'this statement must not acquire another column write without a deliberate decision — "publishedAt" in particular is what this function\'s status CASE reads, and moving it would change the restored status'
      ).toEqual(['"deletedAt"', '"deletedBy"', '"status"', '"updatedAt"']);
    });

    // Pinning the VALUE, not just the presence of the target. This is what
    // catches a `CASE ... THEN now() ELSE "updatedAt" END` mutant — which would
    // leave exactly the Draft rows the reaper eats still carrying a stale clock
    // — and equally a `now() - INTERVAL '31 days'` one, which is the defect
    // spelled as a fix.
    it('assigns "updatedAt" exactly now(), unconditionally', async () => {
      await restoreModelById({ id: MODEL_ID });

      const updatedAt = modelSetAssignments().find(([target]) => target === '"updatedAt"');
      expect(
        updatedAt?.[1],
        'a conditional or offset bump leaves the restored row inside the reaper window'
      ).toBe('now()');
    });
  });

  // 🔴 A SCOPE GUARD, not a prohibition — read this before "fixing" it.
  //
  // Bumping ModelVersion."updatedAt" on a system write is not forbidden in this
  // codebase: `unpublishModelById` in this same service does it deliberately,
  // because the column is on the public v1 payload via
  // src/server/selectors/modelVersion.selector.ts and a taken-down version would
  // otherwise serve a pre-take-down timestamp.
  //
  // What this pins is that THIS change did not quietly do that too. The reaper
  // reads `Model."updatedAt"`, so the Model bump is the whole fix; the restored
  // versions' effect on the public payload is a separate decision with its own
  // consequences and wants its own change and its own review. If you are making
  // that decision on purpose, delete this test — do not work around it.
  it('keeps this change scoped to Model."updatedAt" and leaves ModelVersion alone', async () => {
    await restoreModelById({ id: MODEL_ID });

    // versionUpdateSql() asserts the statement was issued at all, so this is not
    // a reassuring zero from a branch that never ran.
    expect(versionUpdateSql()).not.toContain('"updatedAt"');
  });
});
