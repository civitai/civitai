import { readFileSync } from 'fs';
import { globSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { mockPattern } from '~/__tests__/mocks/guarded-specifiers';

/**
 * A test file that mocks `~/server/redis/client` must not hand-type the key CONSTANTS.
 *
 * 🔴 WHY THIS EXISTS. `no-direct-shared-module-mock.test.ts` already enforces that a file
 * should not mock this specifier at all — but 178 files hold an allowlist exemption, and
 * inside an exemption nothing checked that a hand-typed `REDIS_KEYS` matched reality. Fifteen
 * constants across six files had silently drifted from production before anyone looked:
 *
 *   REDIS_KEYS.SESSION.USER_TOKENS   real 'session:user-tokens2'  test 'session:user-tokens'
 *   REDIS_SYS_KEYS.EVENT             real 'event'                 test 'sys:event'
 *   REDIS_KEYS.TAG                   real 'tag'                   test 'caches:tag'
 *   …and one key, NEW_ORDER.IMAGE_RATINGS, that exists nowhere but the test that invented it
 *
 * Those suites passed the whole time. They asserted against keys Redis never sees, so a
 * key-name regression in production could not have failed them. Fixed in #4400; this guard is
 * what stops the class regrowing, because fixing instances without closing the generator just
 * waits for the next one.
 *
 * The fix is always the same, and it is what `src/__tests__/setup.ts` already does globally:
 *
 *   vi.mock(SPECIFIER, async () => ({                 // SPECIFIER = the redis client shim
 *     ...(await import('@civitai/redis/client')),   // real constants, cannot drift
 *     sysRedis: <your stub>,                        // keep your own client override
 *   }));
 *
 * (Written with a placeholder rather than the literal path on purpose — see the note on the
 * synthetic fixture below; the sibling guard scans this file textually and does not skip
 * comments, so spelling it out here reads to it as a real direct mock.)
 *
 * 🔴 A RATCHET, NOT A RULE, and deliberately so. 52 files hand-type these blocks today; a
 * hard rule would be red on all of them from day one, and a permanently-red gate is worse
 * than no gate — it trains everyone to click through. Some of those are also LEGITIMATE:
 * `BLOCKS.TOKEN_RATE_LIMIT: 'rl'` is a deliberate short stub, not drift. So this does not
 * judge the values; it only refuses to let the set GROW.
 *
 * It fails in BOTH directions, matching the sibling guard. A stale entry — a file that has
 * been fixed but is still listed — fails too, because that is the direction that gets left
 * out of allowlists and is how a merge silently re-adds one.
 *
 * 🔴 AND THE TWO-WAY SHAPE IS WHAT KEEPS THIS GUARD HONEST, which is worth spelling out
 * because it is not obvious. A detector that silently stops matching — a broken regex, a
 * changed `vi.mock` spelling, a globSync that resolves the wrong root — finds NOTHING, and
 * "nothing" passes an additions-only check while reporting a clean repo. Here it cannot:
 * every one of the baseline entries below is a known positive, so a detector that goes blind
 * turns all of them stale and the second test fails loudly. The baseline is not just a
 * ratchet; it is a standing positive control with dozens of samples. Verified by mutation —
 * neutering the key-property regex and neutering `mockPattern` were each caught.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SPECIFIER = '~/server/redis/client';

/** `REDIS_KEYS:` / `REDIS_SYS_KEYS:` / `REDIS_SUB_KEYS:` declared as a factory property. */
const KEY_PROPERTY = /(?:^|[\s,{])REDIS_(?:SYS_|SUB_)?KEYS\s*:/;

/**
 * The body of the `vi.mock(...)` call, found by balancing parens from the match.
 *
 * 🔴 It THROWS rather than returning empty when it cannot find the end. A extractor that
 * degrades to "no match" makes every file look clean, which is exactly the reassuring zero
 * this guard exists to prevent — and it would be indistinguishable from a fixed repo.
 */
function mockCallBody(source: string, startIndex: number, file: string): string {
  let depth = 0;
  let quote: string | null = null;
  let comment: 'line' | 'block' | null = null;
  for (let i = startIndex; i < source.length; i++) {
    const c = source[i];
    // 🔴 COMMENTS ARE SKIPPED, and this is not defensive padding. An apostrophe in an
    // ordinary `//` comment inside a factory — "they're type-only", in
    // src/server/utils/__tests__/rate-limiting.test.ts:43 — reads as a string opener to a
    // naive scanner, which then swallows the rest of the file and never balances. Caught by
    // the throw below on the first run of this guard.
    if (comment === 'line') {
      if (c === '\n') comment = null;
      continue;
    }
    if (comment === 'block') {
      if (c === '*' && source[i + 1] === '/') {
        comment = null;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      comment = 'line';
      i++;
    } else if (c === '/' && source[i + 1] === '*') {
      comment = 'block';
      i++;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return source.slice(startIndex, i + 1);
    }
  }
  throw new Error(
    `could not find the end of the vi.mock('${SPECIFIER}') call in ${file}. ` +
      'The extractor is broken; do NOT read a clean result from this guard until it is fixed.'
  );
}

function filesHandTypingKeyConstants(): string[] {
  const pattern = mockPattern(SPECIFIER);
  const found: string[] = [];
  const files = globSync('src/**/*.test.{ts,tsx}', { cwd: repoRoot });
  for (const rel of files) {
    const source = readFileSync(path.join(repoRoot, rel), 'utf8');
    const m = pattern.exec(source);
    if (!m) continue;
    if (KEY_PROPERTY.test(mockCallBody(source, m.index, rel))) found.push(rel);
  }
  return found.sort();
}

/**
 * Files that hand-type key constants inside their `~/server/redis/client` mock.
 *
 * 🔴 THIS LIST MAY ONLY SHRINK. Removing an entry means the file now spreads
 * `@civitai/redis/client` instead. Adding one is the regression this guard exists to stop —
 * so if a new file lands here, convert it rather than appending. If a value in one of these
 * genuinely has to be a stub (a short synthetic rate-limit key, say), spread the package AND
 * override that single key, which keeps every other constant real.
 */
const HAND_TYPED_BASELINE: string[] = [
  'src/server/auth/__tests__/session-client.test.ts',
  'src/server/events/__tests__/base-event.sysredis-soft.test.ts',
  'src/server/games/daily-challenge/__tests__/challenge-helpers.test.ts',
  'src/server/games/daily-challenge/__tests__/daily-challenge-utils.sysredis-soft.test.ts',
  'src/server/games/new-order/__tests__/cooldown.test.ts',
  'src/server/jobs/__tests__/cache-cleanup.test.ts',
  'src/server/jobs/__tests__/restore-user-images.test.ts',
  'src/server/jobs/__tests__/rewards-abuse-prevention.test.ts',
  'src/server/metrics/__tests__/base.metrics.test.ts',
  'src/server/orchestrator/__tests__/get-orchestrator-token.sysredis-soft.test.ts',
  'src/server/redis/__tests__/model-version-public-donation-goals-cache.test.ts',
  'src/server/redis/__tests__/queues.test.ts',
  'src/server/routers/__tests__/track.router.blockRender.test.ts',
  'src/server/services/blocks/__tests__/app-bounty-cap.service.test.ts',
  'src/server/services/blocks/__tests__/app-spend-cap-rejection-signal.test.ts',
  'src/server/services/blocks/__tests__/app-spend-cap.service.test.ts',
  'src/server/services/blocks/__tests__/checkpoint.service.test.ts',
  'src/server/services/blocks/__tests__/custom-comfy-settle.service.test.ts',
  'src/server/services/blocks/__tests__/dev-tunnel.service.test.ts',
  'src/server/services/generation/__tests__/generation.service.client-rejections.test.ts',
  'src/server/services/generation/__tests__/generation.service.generation-disabled-flag.test.ts',
  'src/server/services/generation/__tests__/generation.service.hidden-prompt.test.ts',
  'src/server/services/generation/__tests__/generation.service.resource-data-aliasing.test.ts',
  'src/server/services/generation/__tests__/generation.service.scheduled-status.test.ts',
  'src/server/services/generation/__tests__/generation.service.sysredis-soft.test.ts',
  'src/server/services/orchestrator/__tests__/orchestration-new.air-map.test.ts',
  'src/server/services/orchestrator/__tests__/orchestration-new.collector-attach.test.ts',
  'src/server/services/orchestrator/__tests__/orchestration-new.getGenerationStatus.sysredis-soft.test.ts',
  'src/server/services/orchestrator/__tests__/orchestration-new.model-substitutions.test.ts',
  'src/server/services/orchestrator/__tests__/orchestration-new.substitution-replies.test.ts',
  'src/server/services/orchestrator/__tests__/promptAuditing.benign-phrases.test.ts',
  'src/server/services/orchestrator/__tests__/promptAuditing.soft-block.test.ts',
  'src/server/services/orchestrator/__tests__/promptAuditing.sysredis-soft.test.ts',
  'src/server/utils/__tests__/block-gen-idempotency.test.ts',
  'src/server/utils/__tests__/block-tip-rate-limit.test.ts',
  'src/server/utils/__tests__/rate-limiting.test.ts',
  'src/tests/api/health.runHealthChecks.test.ts',
  'src/tests/api/internal/blocks/build-callback.test.ts',
  'src/tests/api/internal/blocks/review-build-callback.test.ts',
  'src/tests/api/tier1-public-route-disclosure.test.ts',
  'src/tests/api/v1/blocks/dev-token.test.ts',
  'src/tests/api/v1/blocks/submissions.test.ts',
  'src/tests/api/v1/blocks/withdraw.test.ts',
  'src/tests/api/v1/block-tokens/dev-tunnel-mint.test.ts',
  'src/tests/api/v1/block-tokens/dev-tunnel-owned-nonapproved-mint.test.ts',
  'src/tests/api/v1/block-tokens/index.test.ts',
  'src/tests/api/v1/block-tokens/page-mint.test.ts',
  'src/tests/api/webhooks/resource-training-v2.service-contract.test.ts',
  'src/__tests__/pages/api/download/download-quota-seam.test.ts',
  'src/__tests__/pages/api/download/model-version-blocklist.test.ts',
  'src/__tests__/pages/api/download/split-query-repair.test.ts',
  'src/tests/server/utils/apps-catalog-rate-limit.test.ts',
];

describe('no hand-typed Redis key constants in a guarded mock', () => {
  // 🔴 POSITIVE CONTROL, first. Every assertion below reads a set that a broken extractor
  // renders EMPTY — and an empty set passes the "no additions" check silently. This proves
  // the machinery can still see a violation before any verdict is trusted.
  it('the detector can still find a hand-typed key constant', () => {
    // 🔴 THE SPECIFIER IS CONCATENATED, NOT WRITTEN WHOLE. Its sibling guard
    // `no-direct-shared-module-mock.test.ts` scans test files TEXTUALLY for
    // `vi.mock('<canonical specifier>'`, so a synthetic fixture containing that literal
    // reads as a real violation and fails that guard instead. Measured — it did. Keep the
    // split; do not "tidy" these back into one string.
    const CALL = 'vi.mock(' + "'~/server/redis/client'";
    const synthetic = [
      `${CALL}, () => ({`,
      '  sysRedis: {},',
      "  REDIS_SYS_KEYS: { SESSION: { ALL: 'nope' } },",
      '}));',
    ].join('\n');
    const m = mockPattern(SPECIFIER).exec(synthetic);
    expect(m, 'mockPattern no longer matches a plain vi.mock of the specifier').not.toBeNull();
    expect(KEY_PROPERTY.test(mockCallBody(synthetic, m!.index, '<synthetic>'))).toBe(true);

    // …and that it does NOT fire on the correct shape, or the ratchet would be unfixable.
    const correct = [
      `${CALL}, async () => ({`,
      "  ...(await import('@civitai/redis/client')),",
      '  sysRedis: {},',
      '}));',
    ].join('\n');
    const m2 = mockPattern(SPECIFIER).exec(correct);
    expect(KEY_PROPERTY.test(mockCallBody(correct, m2!.index, '<synthetic>'))).toBe(false);
  });

  it('no NEW file hand-types Redis key constants', () => {
    const added = filesHandTypingKeyConstants().filter((f) => !HAND_TYPED_BASELINE.includes(f));
    expect(
      added,
      'These files hand-type REDIS_KEYS / REDIS_SYS_KEYS / REDIS_SUB_KEYS inside a\n' +
        `vi.mock(${SPECIFIER}) factory. Hand-typed constants drift from\n` +
        'production silently — 15 of them had, before #4400. Spread the real package instead:\n' +
        "  ...(await import('@civitai/redis/client'))\n" +
        'Do NOT add the file to HAND_TYPED_BASELINE; that list may only shrink.'
    ).toEqual([]);
  });

  it('every baseline entry is still a real violation', () => {
    const current = filesHandTypingKeyConstants();
    const stale = HAND_TYPED_BASELINE.filter((f) => !current.includes(f));
    expect(
      stale,
      'These files are listed in HAND_TYPED_BASELINE but no longer hand-type key constants.\n' +
        'Remove them — a stale exemption is how a re-added violation goes unwatched, and it is\n' +
        'the direction allowlists routinely get wrong.'
    ).toEqual([]);
  });
});
