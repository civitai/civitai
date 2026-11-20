import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * 🔴 Fails when a moderation, report, appeal, legal-hold or CSAM test or fixture, or any test or
 * fixture that pairs a user id with a report id, holds an id-sized number outside the synthetic range. Ids in these fixtures come from `SYNTHETIC_MIN`..`SYNTHETIC_MAX`,
 * so a fixture never carries the id of a real account or record. Small ids (under 10 000), round
 * numbers (durations, sizes), values past int4 and UUID segments pass; a genuine non-id constant
 * goes in `BASELINE` with its file. Support-desk ids (`conversationId`, `group_id`, `ticketId`) are
 * past int4, so under those keys a value must come from `DESK_MIN`..`DESK_MAX`. Control values sit
 * above any live id range.
 */

const REPO = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'scripts', 'apps', 'packages'].map((dir) => path.join(REPO, dir));

const SYNTHETIC_MIN = 990_000_000;
const SYNTHETIC_MAX = 990_999_999;
const INT4_MAX = 2_147_483_647;
const DESK_MIN = 990_000_000_000;
const DESK_MAX = 990_999_999_999;
const DESK_KEY = /(?:conversation|group|ticket)_?id['"`]?\s*[:=]\s*$/i;
/** A count or size setting (`maxOpen`, `minScore`, `rateLimit`), never an id-named key such as `maxUserId`. */
const CAP_KEY =
  /\b(?:max|min)(?![\w$]*id\b)[\w$]*['"`]?\s*[:=]\s*['"`]?\s*$|(?:limit|cap)['"`]?\s*[:=]\s*['"`]?\s*$/i;

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mts', '.mjs', '.svelte', '.sql', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', '.next', 'build', 'dist', '.turbo']);

/**
 * Literals in scope that are not record ids (SQLSTATE codes, counts, sizes, timestamps, bounds), by
 * file. Shrink only: a new id-sized value in one of these files still fails.
 */
const BASELINE: Record<string, string[]> = {
  'apps/moderator/src/lib/__tests__/feedback-technical-summary.test.ts': ['12345'],
  'apps/moderator/src/lib/__tests__/format.test.ts': ['12345'],
  'apps/moderator/src/lib/__tests__/training-model-filter.test.ts': ['12345'],
  'apps/moderator/src/lib/server/__tests__/abuse-detection.run-list.test.ts': ['42501', '42703'],
  'apps/moderator/src/lib/server/__tests__/abuse-detection.verdict.test.ts': ['42703'],
  'apps/moderator/src/lib/server/__tests__/app-upload-batches.service.test.ts': ['42501'],
  'apps/moderator/src/lib/server/__tests__/appeal-approve-restores-locked.pglite.test.ts': [
    '1234567890',
  ],
  'apps/moderator/src/lib/server/__tests__/bulk-image-sql.test.ts': ['42601'],
  'apps/moderator/src/lib/server/__tests__/buzz-balance-colour.test.ts': [
    '95030',
    '131811',
    '467019',
    '1527146',
  ],
  'apps/moderator/src/lib/server/__tests__/creator-score-grant-page-action.test.ts': ['10014899'],
  'apps/moderator/src/lib/server/__tests__/extend-membership-action.test.ts': ['1795314120'],
  'apps/moderator/src/lib/server/__tests__/feedback-bulk.pglite.test.ts': ['99999'],
  'apps/moderator/src/lib/server/__tests__/feedback-pglite.harness.ts': ['42703'],
  'apps/moderator/src/lib/server/__tests__/feedback.service.test.ts': ['23505', '42703'],
  'apps/moderator/src/lib/server/__tests__/held-media-route.test.ts': ['999999999'],
  'apps/moderator/src/lib/server/__tests__/job-queue-health.test.ts': ['63660'],
  'apps/moderator/src/lib/server/__tests__/linked-accounts.test.ts': ['99999999'],
  'apps/moderator/src/lib/server/__tests__/model-lookup-resolve.test.ts': ['12341234'],
  'apps/moderator/src/lib/server/__tests__/relabel-batch-build.pglite.test.ts': ['57014'],
  'apps/moderator/src/lib/server/__tests__/reports.sql.test.ts': ['42601'],
  'apps/moderator/src/lib/server/__tests__/scan-label-queue.pglite.test.ts': [
    '10041',
    '44972',
    '44987',
  ],
  'apps/moderator/src/lib/server/__tests__/shop-refund.pglite.test.ts': ['1229455361'],
  'apps/moderator/src/lib/server/__tests__/text-relabel-snapshot.pglite.test.ts': ['23514'],
  'apps/moderator/src/lib/server/__tests__/text-scan-harness-client.test.ts': ['600001'],
  'apps/moderator/src/lib/server/__tests__/ticket-lora-runs.test.ts': ['99999'],
  'apps/moderator/src/lib/server/__tests__/user-workflows-by-id.test.ts': ['20260818'],
  'apps/moderator/src/lib/server/assistant/__tests__/tools.test.ts': ['1795314120'],
  // An item cap passed as a tuple value, not under a cap key (#9503).
  'apps/moderator/src/lib/server/knights/__tests__/sources-config.pglite.test.ts': ['1000001'],
  'apps/moderator/src/lib/server/text-scan-lab/__tests__/try.test.ts': ['600001'],
  'apps/moderator/src/routes/admin/__tests__/csam-flag-release-actions.test.ts': ['1234567890'],
  'apps/moderator/src/routes/admin/unpublished-version-posts/__tests__/actions.test.ts': [
    '1234567890',
  ],
  'apps/moderator/src/routes/api/user-prompt-scans/[userId]/__tests__/user-prompt-scans-endpoint.test.ts':
    ['36500'],
  'apps/moderator/src/routes/images/__tests__/scan-label-vote-action.test.ts': ['402026'],
  'apps/moderator/src/routes/users/scam-restrictions/__tests__/load.test.ts': ['12345'],
  'src/__tests__/pages/api/mod/held-media.test.ts': ['999999999'],
  'src/__tests__/pages/api/v1/model-versions/mini-moderation-block.test.ts': ['131072'],
  'src/components/Moderation/HuggingFaceImport/ImportQueueTable.browser.test.tsx': ['268435456'],
  'src/server/__tests__/game-frame-report.test.ts': ['12345'],
  'src/server/schema/blocks/__tests__/offsite-moderation.schema.test.ts': ['23514'],
  'src/server/services/__tests__/csam-archive-stream-upload.test.ts': ['12345'],
  'src/server/services/__tests__/csam-original-image.test.ts': ['12345'],
  'src/server/services/__tests__/model-moderation.adapter.test.ts': ['49998', '84129', '2862887'],
  'src/server/services/__tests__/stripe.reinstateSubscription.moderation-cancel.test.ts': ['86400'],
  'src/server/services/apps/__tests__/shared-data-moderation.test.ts': ['20001'],
  'src/server/services/blocks/__tests__/app-moderator-message.service.test.ts': ['23514'],
  'src/server/services/blocks/__tests__/offsite-moderation.service.mod-actions.test.ts': ['12345'],
};

const isTestOrFixture = (repoPath: string) =>
  /\.test\.[cm]?[jt]sx?$/.test(repoPath) ||
  /\.fixture\.[a-z]+$/.test(repoPath) ||
  /\/__tests__\/[^/]+\.[cm]?[jt]sx?$/.test(repoPath) ||
  /\/_{0,2}fixtures?_{0,2}\//.test(repoPath);

const MODERATION_PATH = /^apps\/moderator\/|csam|report|appeal|moderat|legal-hold|held-/i;
const idKey = (name: string) => new RegExp(`${name}_?id['"\`]?\\s*[:=]`, 'i');
const pairsUserAndReport = (source: string) =>
  idKey('report').test(source) && idKey('user').test(source);

function inScope(repoPath: string, source: string): boolean {
  return (
    isTestOrFixture(repoPath) && (MODERATION_PATH.test(repoPath) || pairsUserAndReport(source))
  );
}

/** Integer literals, bare or as an all-digit string, that look like an id and are not synthetic. */
function unsyntheticIds(source: string): string[] {
  const found: string[] = [];
  // Not part of a decimal, path, time (`12:34`), cast (`::`), dashed token (`run-123`) or UUID.
  const literal =
    /(?<![\w.$#/\\])(?<!\d:)(?<!::)(?<![0-9A-Za-z_]-)(['"`]?)([1-9][0-9_]*[0-9])\1(?=n\b|(?![\w.]))(?!-[0-9a-fA-F]{4}-)/g;
  for (const match of source.matchAll(literal)) {
    const digits = match[2].replace(/_/g, '');
    if (!/^\d+$/.test(digits) || digits.length > 12) continue;
    if (match[1] && digits.length < 6) continue; // quoted codes such as SQLSTATE '23505'
    const n = Number(digits);
    if (n >= INT4_MAX && DESK_KEY.test(source.slice(Math.max(0, match.index - 40), match.index))) {
      if (n < DESK_MIN || n > DESK_MAX) found.push(digits);
      continue;
    }
    if (CAP_KEY.test(source.slice(Math.max(0, match.index - 40), match.index))) continue;
    // Under 10 000, round, or past int4 (no row id is that large).
    if (n < 10_000 || n % 1000 === 0 || n >= INT4_MAX) continue;
    if (n >= SYNTHETIC_MIN && n <= SYNTHETIC_MAX) continue;
    found.push(digits);
  }
  return found;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

const toRepoPath = (file: string) => path.relative(REPO, file).split(path.sep).join('/');
const files = ROOTS.flatMap((root) => walk(root))
  .map((full) => ({ full, repoPath: toRepoPath(full) }))
  .filter(({ repoPath }) => isTestOrFixture(repoPath) && repoPath !== toRepoPath(__filename))
  .filter(({ full, repoPath }) => inScope(repoPath, readFileSync(full, 'utf8')));

describe('🔴 moderation test fixtures use synthetic ids', () => {
  it('the scan reached the moderation tests', () => {
    expect(files.length).toBeGreaterThan(800);
    expect(files.map((f) => f.repoPath)).toContain(
      'apps/moderator/src/lib/server/__tests__/csam-archive-run.pglite.test.ts'
    );
  });

  it.each([
    [
      'a user id and a report id as query params',
      `db.query(START, ['report', 2100000017, null, 2100000003]);`,
    ],
    ['an object key', `const report = { id: 2100000003, userId: 2100000017 };`],
    ['a SQL insert', `INSERT INTO "CsamReport" ("id", "userId") VALUES (2100000003, 2100000017);`],
    ['an all-digit string', `const user = { id: '2100000017' };`],
    ['a separated literal', `userId: 2_100_000_017,`],
    ['minified JSON', `{"id":2100000003,"userId":2100000017}`],
    ['an unspaced key', `{id:2100000017}`],
    ['a negative literal', `const x = -2100000017;`],
    ['a bigint', `const id = 2100000017n;`],
    ['a support-desk conversation id', `{ conversationId: '210000000017' }`],
    ['a support-desk group id', `{ group_id: 210000000017 }`],
    ['a support-desk ticket id', `answer_ticket_id: '210000000017',`],
    ['an id under a max-prefixed key', `const page = { maxUserId: 123456 };`],
  ])('flags %s', (_, source) => {
    expect(unsyntheticIds(source).length).toBeGreaterThan(0);
  });

  it('scopes any test that pairs a user id with a report id', () => {
    const pair = `const report = { reportId: 990000001, userId: 990000002 };`;
    expect(inScope('src/server/services/__tests__/messages.test.ts', pair)).toBe(true);
    expect(inScope('src/server/services/__tests__/messages.test.ts', `{ userId: 990000002 }`)).toBe(
      false
    );
    expect(inScope('src/server/services/messages.ts', pair)).toBe(false);
  });

  it.each([
    ['synthetic ids', `db.query(START, ['report', 990000002, null, 990000001]);`],
    ['small ids', `const report = { id: 1, userId: 42, imageId: 9999 };`],
    ['round numbers', `const timeoutMs = 60000; const bytes = 1_048_576_000;`],
    ['decimals and dotted versions', `const v = 'v0.2.10'; const ratio = 0.123456;`],
    ['identifiers and hex', `const user12345 = 0x1f2e3d4c; const k = 'abc12345';`],
    ['dates and SQLSTATE strings', `'2026-11-14'; code === '23505';`],
    ['UUIDs', `const KEY = '11112222-3333-4444-8555-666677778888';`],
    ['int4 bounds and values past them', `n <= 2_147_483_647; const big = 10_000_000_019;`],
    [
      'count and size settings',
      `{ maxOpen: 18300, minScore: 25000, rateLimit: 12345 }; draft.maxOpen = ' 18300 ';`,
    ],
    [
      'support-desk ids from the fake range',
      `{ conversationId: '990000000001', group_id: 990000000003 }`,
    ],
    [
      'times, casts and dashed tokens',
      `'23:59:59.123456'; x::int8; 'run-2100000017'; 'abc-123456'`,
    ],
  ])('passes %s', (_, source) => {
    expect(unsyntheticIds(source)).toEqual([]);
  });

  it('each in-scope file holds only synthetic ids, beyond its baseline', () => {
    const offenders: string[] = [];
    for (const { full, repoPath } of files) {
      const allowed = new Set(BASELINE[repoPath] ?? []);
      const extra = [...new Set(unsyntheticIds(readFileSync(full, 'utf8')))].filter(
        (n) => !allowed.has(n)
      );
      if (extra.length) offenders.push(`${repoPath}: ${extra.join(', ')}`);
    }
    expect(
      offenders,
      `Use ids from ${SYNTHETIC_MIN}..${SYNTHETIC_MAX} in these fixtures (small ids under 10000 also pass).`
    ).toEqual([]);
  });

  it('every baseline entry is still in its file', () => {
    const stale: string[] = [];
    for (const [repoPath, literals] of Object.entries(BASELINE)) {
      const present = new Set(unsyntheticIds(readFileSync(path.join(REPO, repoPath), 'utf8')));
      for (const n of literals) if (!present.has(n)) stale.push(`${repoPath}: ${n}`);
    }
    expect(stale, 'Remove these from BASELINE').toEqual([]);
  });
});
