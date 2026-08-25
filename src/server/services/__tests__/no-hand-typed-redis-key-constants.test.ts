import { globSync, readFileSync, statSync } from 'fs';
import path from 'path';
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
 * what stops the class regrowing.
 *
 * The fix is always the same, and it is what `src/__tests__/setup.ts` already does globally:
 * spread `@civitai/redis/client` into the factory for the real constants, and keep only your
 * own client stub and control-surface overrides as explicit properties.
 *
 * 🔴 A RATCHET, NOT A RULE, and deliberately so. 53 files hand-type these blocks today; a
 * hard rule would be red on all of them from day one, and a permanently-red gate is worse
 * than no gate — it trains everyone to click through. Some are also LEGITIMATE:
 * `BLOCKS.TOKEN_RATE_LIMIT: 'rl'` is a deliberate short stub, not drift. So this does not
 * judge the values; it only refuses to let the set GROW.
 *
 * It fails in BOTH directions. A stale entry — a file fixed but still listed — fails too,
 * because that is the direction allowlists routinely get wrong.
 *
 * 🔴 THE TWO-WAY SHAPE IS WHAT KEEPS THE GUARD HONEST, and it is worth spelling out. A
 * detector that silently stops matching finds NOTHING, and "nothing" passes an additions-only
 * check while reporting a clean repo. Here it cannot: every baseline entry is a known
 * positive, so a detector that goes BLIND turns them all stale and the second test fails
 * loudly. Verified by mutation — narrowing the glob, breaking the root path, and neutering
 * either regex are each caught.
 *
 * 🔴 BUT BLIND IS NOT THE SAME AS NARROW, AND THIS GUARD IS NARROW. The baseline proves only
 * that the detector still fires on the shapes it was built from. An adversarial audit of the
 * first revision found a file it could not see at all — `ban-session-revocation.test.ts`
 * built its constants in a `vi.hoisted()` block and spread them in as `...h.KEYS`, so the
 * factory body held no `REDIS_*_KEYS:` property and the file sailed through carrying THREE
 * live drifts, `'session:usertokens'` among them. That is not an exotic evasion: 57 of the 66
 * files mocking this specifier already use `vi.hoisted()`, so it was one ordinary refactor
 * away for most of the population — and it made the guard go green rather than red.
 *
 * The fix was to stop parsing. This now scans the WHOLE FILE for the property literal rather
 * than the factory body, which catches the hoisted shape and deletes an entire class of
 * fragility with it: there is no paren-balancing extractor to run off the end of a regex
 * literal, no first-textual-match anchor for a commented-out `vi.mock` to hijack, and no
 * silent truncation. It trades those for FALSE POSITIVES — a comment that merely mentions
 * `REDIS_KEYS:` counts — and that is the right trade, because a false positive costs one
 * baseline line or a reword while a false negative costs the invariant.
 *
 * 🔴 KNOWN GAPS, stated so nobody reads this as complete. It does not see: `vi.doMock`
 * (`mockPattern` matches `vi.mock(` only — zero uses on this specifier today); a specifier
 * built from a variable or template literal; a computed (`[K]:`) or shorthand (`REDIS_KEYS,`)
 * property; a factory delegating to a helper that lives in another file. Widen it when one of
 * those appears rather than assuming the set below is the population.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SPECIFIER = '~/server/redis/client';

/**
 * `REDIS_KEYS:` / `REDIS_SYS_KEYS:` / `REDIS_SUB_KEYS:` written as a property key, quoted or
 * bare. Deliberately loose: it runs over the whole file, so anything it over-matches lands in
 * the baseline rather than escaping it.
 */
const KEY_PROPERTY = /(?:^|[\s,{])['"]?REDIS_(?:SYS_|SUB_)?KEYS['"]?\s*:/;

function filesHandTypingKeyConstants(): string[] {
  const pattern = mockPattern(SPECIFIER);
  const found: string[] = [];
  // 🔴 EVERY vitest project's test root, not just the `unit` one. An earlier revision walked
  // `src/**` + `scripts/**` and its comment claimed that matched "the project's own include" —
  // but `packages/*` and `apps/*` are SEPARATE vitest projects carrying 175 more test files
  // that the walk simply forgot. That gap is empty today (measured: 0 of the 175 mock this
  // specifier), which is exactly why it would have gone unnoticed until it wasn't.
  const globs = [
    'src/**/*.test.{ts,tsx}',
    'scripts/**/*.test.{ts,tsx}',
    'packages/*/src/**/*.test.{ts,tsx}',
    'apps/*/src/**/*.test.{ts,tsx}',
  ];
  for (const g of globs) {
    for (const rel of globSync(g, { cwd: REPO_ROOT })) {
      // 🔴 Node's glob joins with the platform separator, so this is `src\…` on Windows and
      // every baseline entry would read as both a new violation AND a stale one. Four sibling
      // guards in this directory normalise for the same reason; the first revision of this one
      // did not, and Windows CI runs no test suite, so nothing would have caught it there.
      const file = rel.replace(/\\/g, '/');
      // This guard's own fixtures necessarily talk about the specifier.
      if (file.endsWith('no-hand-typed-redis-key-constants.test.ts')) continue;
      // A full-suite run can create a directory matching the glob mid-walk, which reaches
      // readFileSync as EISDIR. The sibling guard documents observing exactly that.
      const abs = path.join(REPO_ROOT, rel);
      if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
      const source = readFileSync(abs, 'utf8');
      if (pattern.test(source) && KEY_PROPERTY.test(source)) found.push(file);
    }
  }
  return [...new Set(found)].sort();
}

/**
 * Files that hand-type key constants alongside a `~/server/redis/client` mock.
 *
 * 🔴 THIS LIST MAY ONLY SHRINK — and that is now enforced by the length cap below rather than
 * left to good intentions. Removing an entry means the file spreads `@civitai/redis/client`
 * instead. If a value genuinely has to be a stub (a short synthetic rate-limit key, say),
 * spread the package AND override that one key, which keeps every other constant real.
 */
const HAND_TYPED_BASELINE: string[] = [
  'src/__tests__/pages/api/download/download-quota-seam.test.ts',
  'src/__tests__/pages/api/download/model-version-blocklist.test.ts',
  'src/__tests__/pages/api/download/split-query-repair.test.ts',
  'src/server/auth/__tests__/ban-session-revocation.test.ts',
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
  'src/tests/api/v1/block-tokens/dev-tunnel-mint.test.ts',
  'src/tests/api/v1/block-tokens/dev-tunnel-owned-nonapproved-mint.test.ts',
  'src/tests/api/v1/block-tokens/index.test.ts',
  'src/tests/api/v1/block-tokens/page-mint.test.ts',
  'src/tests/api/v1/blocks/dev-token.test.ts',
  'src/tests/api/v1/blocks/submissions.test.ts',
  'src/tests/api/v1/blocks/withdraw.test.ts',
  'src/tests/api/webhooks/resource-training-v2.service-contract.test.ts',
  'src/tests/server/utils/apps-catalog-rate-limit.test.ts',
];

describe('no hand-typed Redis key constants in a guarded mock', () => {
  // 🔴 POSITIVE CONTROL, first. Every assertion below reads a set that a broken detector
  // renders EMPTY, and an empty set passes an additions-only check silently.
  it('the detector still fires on both the inline and the hoisted shape', () => {
    // Split so this file's own fixture is not a literal `vi.mock('<specifier>'` — the sibling
    // guard scans textually, without skipping comments, and would read it as a real mock.
    const CALL = 'vi.mock(' + "'~/server/redis/client'";
    const inline = `${CALL}, () => ({ sysRedis: {}, REDIS_SYS_KEYS: { SESSION: { ALL: 'x' } } }));`;
    // The shape that defeated the first revision: constants built above, spread in.
    const hoisted = [
      "const h = vi.hoisted(() => ({ KEYS: { REDIS_KEYS: { TAG: 'x' } } }));",
      `${CALL}, () => ({ sysRedis: {}, ...h.KEYS }));`,
    ].join('\n');
    const quoted = `${CALL}, () => ({ 'REDIS_KEYS': { TAG: 'x' } }));`;
    for (const [name, sample] of [
      ['inline', inline],
      ['hoisted', hoisted],
      ['quoted key', quoted],
    ] as const) {
      expect(mockPattern(SPECIFIER).test(sample), `${name}: mock no longer matched`).toBe(true);
      expect(KEY_PROPERTY.test(sample), `${name}: key property no longer matched`).toBe(true);
    }
    // …and it must NOT fire on the correct shape, or the ratchet would be unfixable.
    const correct = `${CALL}, async () => ({ ...(await import('@civitai/redis/client')), sysRedis: {} }));`;
    expect(KEY_PROPERTY.test(correct)).toBe(false);
  });

  it('no NEW file hand-types Redis key constants', () => {
    const added = filesHandTypingKeyConstants().filter((f) => !HAND_TYPED_BASELINE.includes(f));
    expect(
      added,
      'These files hand-type REDIS_KEYS / REDIS_SYS_KEYS / REDIS_SUB_KEYS alongside a mock of\n' +
        `${SPECIFIER}. Hand-typed constants drift from production silently — 15 of them had,\n` +
        "before #4400. Spread the real package instead: ...(await import('@civitai/redis/client')).\n" +
        'That list may only shrink, so do NOT append a real violation to it. The one exception\n' +
        'is a FALSE POSITIVE — a file that mocks correctly and only mentions the constant in a\n' +
        'comment or a type. Reword the mention if you can; if not, add the entry and raise the\n' +
        'count in `the baseline is exactly the recorded size` in the same commit, saying why.'
    ).toEqual([]);
  });

  it('every baseline entry is still a real violation', () => {
    const current = filesHandTypingKeyConstants();
    const stale = HAND_TYPED_BASELINE.filter((f) => !current.includes(f));
    expect(
      stale,
      'These files are listed in HAND_TYPED_BASELINE but no longer hand-type key constants.\n' +
        'Remove them — a stale exemption is how a re-added violation goes unwatched.'
    ).toEqual([]);
  });

  // 🔴 `toBe`, NOT `toBeLessThanOrEqual`, and the difference is the whole point. A `<=` cap
  // stops ratcheting the moment the baseline drops below it: convert five files without
  // editing the literal and a later PR can append five new violations with every test green.
  // That is the same "remember to lower it" social contract the cap was added to replace —
  // it just moved. An exact count forces the edit in BOTH directions, so the number can never
  // silently accumulate headroom.
  //
  // 🔴 WHEN IT IS LEGITIMATE TO RAISE THIS. The detector scans the whole file and is
  // deliberately loose, so a file that mocks the specifier CORRECTLY and merely mentions
  // `REDIS_KEYS:` in a comment or a type is a false positive. That is the accepted cost of not
  // parsing — but it needs a sanctioned remedy, and the failure message's "do NOT add to the
  // baseline" is wrong for that one case. Prefer rewording the comment; if the mention is
  // load-bearing, add the entry AND raise this number in the same commit, with a note saying
  // which it is. A raise is then a visible, reviewable claim rather than a silent one.
  it('the baseline is exactly the recorded size', () => {
    expect(HAND_TYPED_BASELINE.length).toBe(53);
  });
});
