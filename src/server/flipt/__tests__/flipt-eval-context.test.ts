import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

/**
 * 🔴 SOURCE GATE + BEHAVIOURAL PAIR — an entity-scoped Flipt evaluation must
 * carry an evaluation CONTEXT.
 *
 * THE DEFECT CLASS. A Flipt segment constraint reads one of two inputs, and
 * which one is decided by the constraint's TYPE, not by the flag:
 *
 * - `ENTITY_ID_COMPARISON_TYPE` matches the `entityId` ARGUMENT.
 * - `STRING_COMPARISON_TYPE` matches a named property of the CONTEXT argument.
 *
 * Measured against flipt-state's `civitai-app/default/features.yaml`: of the 15
 * segments defined there, 12 are built from `STRING_COMPARISON_TYPE` constraints
 * — every identity, tier and cohort segment we have (`moderators`, `testers`,
 * `early-adopters`, `members`, `app-dev-testers`, `license-fee-tester`,
 * `CreatorProgram`, …). Only three (`is-zach`, `is-koen`, `is-debuggador`) read
 * the entityId. 65 of the 125 flags carry at least one segment rollout.
 *
 * So an evaluation that names a subject in `entityId` and passes NO context can
 * match `all-users` and the three entityId segments, and nothing else. For every
 * other segment it returns the flag's base `enabled` value — which is
 * indistinguishable from an honest "this subject is not in the segment". There
 * is no error, no log line, and no way to tell the two apart from the outside.
 *
 * That is the failure this repo has already paid for twice: once in the feedback
 * gate (fixed in #4042 by threading `buildFliptContext`) and once in
 * `resolveTestingAccess`, whose `testers` rollout was structurally unreachable
 * for every non-moderator (fixed in the commit that adds this file).
 *
 * WHY THE RULE IS "entityId ⇒ context" AND NOT "user-keyed ⇒ context". A scan
 * cannot reliably tell a user-derived entityId from any other: one of the sites
 * below passes a bare local called `entityId` that happens to hold a user id.
 * Keying the rule on the presence of the entityId argument needs no such guess —
 * and it is the honest rule anyway, since an entityId is a claim that the
 * evaluation is scoped to a subject, and a scoped evaluation with no context can
 * only see a quarter of the segment vocabulary. A genuinely global evaluation
 * passes one argument and is not covered here.
 *
 * WHAT THIS IS NOT. It is structural. It cannot tell a CORRECT context from a
 * wrong one — `isFlipt(flag, id, {})` satisfies it. The behavioural claim lives
 * in the second half of this file (the segment predicates below) and, for the
 * one call site fixed alongside this gate, in
 * `generation.service.testing-access-flag-context.test.ts`. This gate exists so
 * that the population those tests speak for cannot silently grow a member.
 */

const SRC = path.resolve(__dirname, '../../..');

/** The four evaluation entry points `~/server/flipt/client` exports. */
const EVAL_FNS = ['isFlipt', 'isFliptSync', 'getFliptBoolean', 'getFliptVariant'] as const;

const SKIP_DIRS = new Set(['node_modules', '__tests__', '__screenshots__']);
const isTestFile = (name: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !isTestFile(entry)) out.push(full);
  }
  return out;
}

/**
 * Blank comments out rather than deleting them, so a reported line number still
 * matches the file on disk. (This file, and `client.ts`, both write example
 * calls in prose; an unstripped scan would count them as call sites.)
 */
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length));

/**
 * Split the argument list starting at `open` (the index of `(`). Depth-counting
 * rather than a regex, because two of the real call sites pass a nested call and
 * one passes an object literal containing a comma.
 */
function splitArgs(src: string, open: number): string[] | null {
  let depth = 0;
  const parts: string[] = [];
  let cur = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        parts.push(cur);
        return parts.map((p) => p.trim()).filter((p, idx) => !(idx === 0 && p === ''));
      }
    }
    if (depth === 1 && c === ',') {
      parts.push(cur);
      cur = '';
      continue;
    }
    if (depth >= 1) cur += c;
  }
  return null;
}

type EvalCall = { site: string; fn: string; argc: number };

function scanEvalCalls(): { calls: EvalCall[]; scanned: number } {
  const calls: EvalCall[] = [];
  let scanned = 0;
  for (const file of walk(SRC)) {
    scanned++;
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const src = stripComments(readFileSync(file, 'utf8'));
    // `[\w$]+\.` so the module-object form (`_fliptModule.isFliptSync(...)`) in
    // feature-flags.service is seen; the leading `[^\w.$]` keeps a longer
    // identifier ending in one of these names out.
    const re = new RegExp(`(?:^|[^\\w.$])(?:[\\w$]+\\.)?(${EVAL_FNS.join('|')})\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const open = src.indexOf('(', m.index + m[0].length - 1);
      const args = splitArgs(src, open);
      if (!args) continue;
      const line = src.slice(0, m.index).split('\n').length;
      calls.push({ site: `${rel}:${line}`, fn: m[1], argc: args.length });
    }
  }
  return { calls, scanned };
}

/**
 * 🔴 HAND-TYPED. Sites that pass an `entityId` and no context, accepted for the
 * stated reason. Every reason was checked against the flag's definition in
 * flipt-state, not assumed.
 *
 * "No segments today" is a statement about the flag as it stands, NOT a licence:
 * add one segment rollout to any of these flags and the site below goes silently
 * wrong. The reason each is here rather than fixed is that the fix is not free —
 * the four feed sites are on hot list paths where `buildFliptContext` was
 * deliberately hoisted out of per-flag work, and the dispute helper has a bare
 * `userId` and no `SessionUser` to build a truthful context from.
 */
const ENTITY_WITHOUT_CONTEXT_LEDGER: Record<string, string> = {
  // flag `article-rating-dispute`: enabled=true, 0 rules, 0 rollouts → answers
  // true for every entity regardless of context. A background auto-resolve path
  // with only `pending.userId` in hand; building a real context would cost a
  // user fetch. Revisit the moment this flag gains a rollout.
  'server/services/article-rating-review.helpers.ts:482':
    'article-rating-dispute has no segment rollouts; background path with no SessionUser',
  // flag `feed-fetch-filter-in-post`: enabled=true, 0 rules, 0 rollouts.
  'server/services/image.service.ts:3126':
    'feed-fetch-filter-in-post has no segment rollouts; hot feed path',
  // flag `feed-image-existence`: enabled=true, 0 rules, 0 rollouts. Three sites.
  'server/services/image.service.ts:3167':
    'feed-image-existence has no segment rollouts; hot feed path',
  'server/services/image.service.ts:3936':
    'feed-image-existence has no segment rollouts; hot feed path',
  'server/services/image.service.ts:4746':
    'feed-image-existence has no segment rollouts; hot feed path',
  // flags `model-text-moderation-xguard` / `-apply`: both enabled=true, 0 rules,
  // 0 rollouts (checked against flipt-state and against the evaluation API on
  // 2026-08-20, which returned DEFAULT_EVALUATION_REASON for both).
  //
  // These two are entity-keyed ON PURPOSE, and a context could not help them. The
  // entityId is a MODEL id, not a user id — every STRING_COMPARISON segment we have
  // describes a person (moderators, testers, members, tiers, cohorts), and none of
  // them can say anything about a model. The intended rollout here is a `threshold`
  // rollout, which buckets on the entityId itself, so the entityId is the whole
  // point rather than a missing context. The adapter also runs from a webhook with
  // no session at all, so there is no SessionUser to build a truthful context from.
  //
  // The caveat above still applies with force: if either flag ever gains a SEGMENT
  // rollout it will silently match nothing here. A percentage rollout is fine.
  'server/services/model-moderation.adapter.ts:123':
    'model-text-moderation-xguard has no segment rollouts; entityId is a MODEL id (no user segment can describe it) and the rollout is threshold-keyed; webhook path with no SessionUser',
  'server/services/model-moderation.adapter.ts:228':
    'model-text-moderation-xguard-apply has no segment rollouts; entityId is a MODEL id (no user segment can describe it) and the rollout is threshold-keyed; webhook path with no SessionUser',
  // flag `text-blurbs`: default-off, no rules and no rollouts.
  //
  // Entity-keyed on purpose. The entityId is the CONTENT OWNER's user id, not the actor's, so a
  // threshold rollout buckets a sticky subset of creators and a moderator editing someone else's
  // page resolves the same blurbs the owner would. Supplying a context would mean assembling a
  // SessionUser for the OWNER — whose session neither a moderator's request nor the fan-out job
  // carries — so it costs a user fetch on a path that runs on every content write.
  //
  // 🔴 So this flag can only be ramped by PERCENTAGE or BOOLEAN. A SEGMENT rollout silently
  // matches nothing here and looks exactly like "blurbs are off". The full warning is on
  // FLIPT_FEATURE_FLAGS.TEXT_BLURBS, which is where someone running the ramp will look.
  'server/services/blurb-materialize.service.ts:66':
    'text-blurbs has no segment rollouts; entityId is the CONTENT OWNER (not the actor) so the intended threshold rollout is sticky per creator; no SessionUser for the owner exists on either the moderator-edit path or the fan-out job',
};

describe('flipt evaluation context — source gate', () => {
  const { calls, scanned } = scanEvalCalls();

  // POSITIVE CONTROLS. Every assertion below compares against this scan, and a
  // scan wired to nothing returns an empty list — which would make "no new
  // context-less evaluation" vacuously true. Floors are well under the real
  // numbers (≈3,800 files, ≈69 calls) so ordinary growth never trips them.
  it('actually walked the server tree', () => {
    expect(scanned).toBeGreaterThan(2500);
  });

  it('actually found Flipt evaluations, of all three argument shapes', () => {
    expect(calls.length).toBeGreaterThan(40);
    // Named shapes, not just a total: a scanner that collapsed every call to one
    // arity would still clear a total-count floor.
    expect(calls.some((c) => c.argc === 1)).toBe(true);
    expect(calls.some((c) => c.argc === 2)).toBe(true);
    expect(calls.some((c) => c.argc >= 3)).toBe(true);
  });

  it('sees a known contexted site as contexted, and a known bare site as bare', () => {
    // The pair matters. A detector hardwired to "3 args" would pass the first of
    // these and fail the second, and vice versa.
    const bySite = new Map(calls.map((c) => [c.site, c]));
    expect(bySite.get('server/services/feedback.service.ts:43')?.argc).toBe(3);
    expect(bySite.get('server/services/image.service.ts:3167')?.argc).toBe(2);
  });

  it('adds no Flipt evaluation that names an entity but passes no context', () => {
    const unledgered = calls
      .filter((c) => c.argc === 2)
      .map((c) => c.site)
      .filter((site) => !(site in ENTITY_WITHOUT_CONTEXT_LEDGER))
      .sort();
    expect(
      unledgered,
      'A Flipt evaluation passes an entityId with no evaluation context. Every identity, ' +
        'tier and cohort segment in flipt-state is a STRING_COMPARISON_TYPE constraint, ' +
        'which reads the CONTEXT and never the entityId — so this evaluation cannot match ' +
        'any of them, and returns the flag default instead. That is indistinguishable from ' +
        '"the subject is not in the segment". Pass `buildFliptContext(user)`, or the ' +
        'properties you actually know; if the flag genuinely has no segment rollout, add ' +
        'the site to ENTITY_WITHOUT_CONTEXT_LEDGER with the reason you checked.'
    ).toEqual([]);
  });

  it('keeps the ledger honest — a fixed or moved site must be removed from it', () => {
    // The direction that gets left out. Without it the ledger silently becomes a
    // list of line numbers that stopped meaning anything, and the next reviewer
    // reads five accepted exceptions that are no longer there.
    const bare = new Set(calls.filter((c) => c.argc === 2).map((c) => c.site));
    const stale = Object.keys(ENTITY_WITHOUT_CONTEXT_LEDGER)
      .filter((site) => !bare.has(site))
      .sort();
    expect(
      stale,
      'A ledgered site no longer passes an entityId without a context — it was fixed, ' +
        'deleted, or the line moved. Drop or update its row.'
    ).toEqual([]);
  });
});

/**
 * THE BEHAVIOURAL HALF.
 *
 * The gate above is a claim about argument counts. On its own it would be
 * satisfied by `isFlipt(flag, id, {})`, and it asserts nothing at all about WHY
 * a context is required. These cases drive the real `buildFliptContext` against
 * hand-typed transcriptions of the live segments and show the mechanism: the
 * same subject matches with a context and does not match without one.
 *
 * The predicates are transcribed from flipt-state's `features.yaml`, so they can
 * disagree with the code. Deriving them from `buildFliptContext`'s output would
 * make them agree with anything.
 */
describe('flipt evaluation context — the mechanism the gate exists for', () => {
  const EARLY_ADOPTER_ID = 8123;
  const PLAIN_ID = 4471;

  const sessionUser = (over: Partial<SessionUser> = {}): SessionUser =>
    ({
      id: PLAIN_ID,
      isModerator: false,
      muted: false,
      onboarding: OnboardingSteps.Buzz,
      isEarlyAdopter: false,
      ...over,
    } as SessionUser);

  /** `early-adopters`: ALL_MATCH over `isEarlyAdopter eq "true"`. */
  const earlyAdopters = (ctx: Record<string, string>) => ctx.isEarlyAdopter === 'true';
  /** `moderators`: ALL_MATCH over `isModerator eq "true"`. */
  const moderators = (ctx: Record<string, string>) => ctx.isModerator === 'true';
  /** `app-dev-testers`: ANY_MATCH over `userId isoneof [...]`. */
  const idListed = (ids: string[]) => (ctx: Record<string, string>) => ids.includes(ctx.userId);
  /** `members`: ANY_MATCH over `isMember eq "true"` OR `isModerator eq "true"`. */
  const members = (ctx: Record<string, string>) =>
    ctx.isMember === 'true' || ctx.isModerator === 'true';

  it('an EMPTY context matches none of the live property segments', () => {
    // This is the whole defect in one line: the entityId is not on offer to any
    // of these, so a context-less evaluation is a uniform miss.
    const empty: Record<string, string> = {};
    expect(earlyAdopters(empty)).toBe(false);
    expect(moderators(empty)).toBe(false);
    expect(members(empty)).toBe(false);
    expect(idListed([String(EARLY_ADOPTER_ID), String(PLAIN_ID)])(empty)).toBe(false);
  });

  it('buildFliptContext emits the properties those segments read', () => {
    const ctx = buildFliptContext(sessionUser({ id: EARLY_ADOPTER_ID, isEarlyAdopter: true }));
    // Hand-typed against the segment constraints, not read back off the helper.
    expect(ctx.isEarlyAdopter).toBe('true');
    expect(ctx.userId).toBe(String(EARLY_ADOPTER_ID));
    expect(ctx.isModerator).toBe('false');
    expect(ctx.isMember).toBe('false');
    expect(ctx.isInCreatorProgram).toBe('false');
    expect(ctx.isLoggedIn).toBe('true');
    expect(ctx.tier).toBe('free');
  });

  it('the same subject matches early-adopters WITH a context and misses WITHOUT one', () => {
    const user = sessionUser({ id: EARLY_ADOPTER_ID, isEarlyAdopter: true });
    // The only thing that changes between the two arms is whether the context is
    // handed over — same user, same segment, opposite answers.
    expect(earlyAdopters(buildFliptContext(user))).toBe(true);
    expect(earlyAdopters({})).toBe(false);
  });

  it('a context is not a rubber stamp — a non-member still misses', () => {
    // The negative control on the case above. Without it, "with a context it
    // matches" would also be satisfied by a predicate wired to true.
    expect(earlyAdopters(buildFliptContext(sessionUser({ isEarlyAdopter: false })))).toBe(false);
    expect(moderators(buildFliptContext(sessionUser({ isModerator: false })))).toBe(false);
    expect(members(buildFliptContext(sessionUser({ tier: 'free' })))).toBe(false);
  });

  it('a userId-list segment reads the CONTEXT property, so the entityId cannot serve it', () => {
    const user = sessionUser({ id: PLAIN_ID });
    const segment = idListed([String(PLAIN_ID)]);
    expect(segment(buildFliptContext(user))).toBe(true);
    // The defect shape: the id was passed, just not where the constraint looks.
    expect(segment({ isModerator: 'false' })).toBe(false);
  });

  it('an anonymous context is a real answer, not an empty one', () => {
    const ctx = buildFliptContext(undefined);
    expect(ctx.isLoggedIn).toBe('false');
    expect(ctx.userId).toBeUndefined();
    expect(earlyAdopters(ctx)).toBe(false);
  });

  it('a tiered user is a member and a moderator is one too', () => {
    expect(members(buildFliptContext(sessionUser({ tier: 'bronze' })))).toBe(true);
    expect(members(buildFliptContext(sessionUser({ isModerator: true })))).toBe(true);
  });
});
