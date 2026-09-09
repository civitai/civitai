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

type EvalCall = { site: string; key: string; enclosing: string; fn: string; argc: number };

/**
 * The top-level declaration a call sits inside — what a ledger row NAMES.
 *
 * Deliberately crude: nearest preceding declaration anchored at column 0, so a nested arrow or an
 * object property cannot claim a site. `src/server/services/blocks/__tests__/` has a careful
 * brace-depth version of this; it is not exported, and neither copying 60 lines nor extracting a
 * shared test helper belongs in a change about a ledger key. What makes a crude parser safe here is
 * that every name it produces is PINNED in the ledger below, so drift fails loudly by name instead
 * of quietly widening what a row forgives.
 *
 * 🔴 `<unattributed>` is a FAILURE, never a forgiveness — see the assertion that rejects it. A row
 * that covered a site the parser could not name would be the cardinality bug again with more steps.
 */
const DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([\w$]+)|^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=|^(?:export\s+)?(?:abstract\s+)?class\s+([\w$]+)/gm;

function enclosingDeclaration(before: string): string {
  DECLARATION.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = DECLARATION.exec(before))) last = m;
  return last ? last[1] || last[2] || last[3] : '<unattributed>';
}

/**
 * What a ledger row is addressed by: the file, and the flag expression as written.
 *
 * NOT the line number. The ledger used to key on `file:line`, which made every PR touching a
 * ledgered file collide there — 19 commits renumbered these rows between 2026-08-20 and 2026-09-08,
 * and the conflict carried no information, because the file itself merged cleanly every time. Worse,
 * two of the three assertions below then reported a renumbering as "a Flipt evaluation passes an
 * entityId with no evaluation context", sending the reader after a Flipt bug that did not exist.
 *
 * The gate's subject is "this call site evaluates this flag without a context", and none of that is
 * positional. The line number is still carried, as `site`, so a failure can say WHERE — it is data,
 * not identity.
 */
const ledgerKey = (rel: string, flagArg: string) =>
  // `splitArgs` accumulates from the opening paren, so the first argument arrives carrying it, and a
  // wrapped call carries the newline and indentation after it too. Both are spelling, not identity —
  // reflowing a call must not rename its row, or the key is a line number again by another name.
  `${rel}#${flagArg.replace(/^\(/, '').replace(/\s+/g, ' ').trim()}`;

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
      calls.push({
        site: `${rel}:${line}`,
        key: ledgerKey(rel, args[0] ?? '(no argument)'),
        enclosing: enclosingDeclaration(src.slice(0, m.index)),
        fn: m[1],
        argc: args.length,
      });
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
type LedgerRow = { fns: string[]; reason: string };

/**
 * 🔴 `fns` IS LOAD-BEARING, and it is why a row is not just `file#flag`. A row forgives the sites it
 * NAMES and no more. Keying on file+flag alone would mean a further uncontexted evaluation of an
 * already-ledgered flag, in an already-ledgered file, arrives pre-forgiven — the gate going silent
 * for exactly the violation it exists to catch. A bare COUNT is not enough either: swapping one
 * ledgered site for a genuinely new one keeps the number and forgives a site nobody reviewed.
 *
 * So each row lists the enclosing declarations it covers, and the assertion below compares that set
 * both ways. `<file>::<enclosing function>` is how the ledgers in
 * `src/server/services/blocks/__tests__/` already address their sites; this is that, with the flag
 * kept in the key.
 *
 * 🔴 RAISING A ROW IS NOT A FORMALITY. Adding a name means the existing `reason` now speaks for that
 * site too — so check it applies to the new one verbatim, not merely that the flag still has no
 * segment rollout. That judgement is the whole value of the row.
 *
 * ⚠️ The trade this makes: renaming one of these functions renames its row, and that is a conflict.
 * It is a rare, loud breakage in place of a frequent silent one — the line-number scheme was
 * renumbered 19 times in three weeks, and a 20th time while this was being written.
 */
const ENTITY_WITHOUT_CONTEXT_LEDGER: Record<string, LedgerRow> = {
  // flag `article-rating-dispute`: enabled=true, 0 rules, 0 rollouts → answers
  // true for every entity regardless of context. A background auto-resolve path
  // with only `pending.userId` in hand; building a real context would cost a
  // user fetch. Revisit the moment this flag gains a rollout.
  'server/services/article-rating-review.helpers.ts#FLIPT_FEATURE_FLAGS.ARTICLE_RATING_DISPUTE': {
    fns: ['maybeAutoResolveDisputeAfterScan'],
    reason: 'article-rating-dispute has no segment rollouts; background path with no SessionUser',
  },
  // flag `feed-fetch-filter-in-post`: enabled=true, 0 rules, 0 rollouts.
  'server/services/image.service.ts#FLIPT_FEATURE_FLAGS.FEED_POST_FILTER': {
    fns: ['searchImages'],
    reason: 'feed-fetch-filter-in-post has no segment rollouts; hot feed path',
  },
  // flag `feed-image-existence`: enabled=true, 0 rules, 0 rollouts. Three sites,
  // same reason at each — which is why they share a row, and why the row names
  // all three rather than counting them.
  'server/services/image.service.ts#FLIPT_FEATURE_FLAGS.FEED_IMAGE_EXISTENCE': {
    fns: [
      'getImagesFromFeedSearch',
      'getImagesFromSearchPreFilter',
      'getImagesFromSearchPostFilter',
    ],
    reason: 'feed-image-existence has no segment rollouts; hot feed path',
  },
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
  'server/services/model-moderation.adapter.ts#FLIPT_FEATURE_FLAGS.MODEL_TEXT_MODERATION_XGUARD': {
    fns: ['submitEnabled'],
    reason:
      'model-text-moderation-xguard has no segment rollouts; entityId is a MODEL id (no user segment can describe it) and the rollout is threshold-keyed; webhook path with no SessionUser',
  },
  'server/services/model-moderation.adapter.ts#FLIPT_FEATURE_FLAGS.MODEL_TEXT_MODERATION_XGUARD_APPLY':
    {
      fns: ['recordForensics'],
      reason:
        'model-text-moderation-xguard-apply has no segment rollouts; entityId is a MODEL id (no user segment can describe it) and the rollout is threshold-keyed; webhook path with no SessionUser',
    },
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
  'server/services/blurb-materialize.service.ts#FLIPT_FEATURE_FLAGS.TEXT_BLURBS': {
    fns: ['expandBlurbs'],
    reason:
      'text-blurbs has no segment rollouts; entityId is the CONTENT OWNER (not the actor) so the intended threshold rollout is sticky per creator; no SessionUser for the owner exists on either the moderator-edit path or the fan-out job',
  },
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
    const byKey = new Map(calls.map((c) => [c.key, c]));
    expect(byKey.get('server/services/feedback.service.ts#feedbackAreaFlagKey(area)')?.argc).toBe(
      3
    );
    expect(
      byKey.get('server/services/image.service.ts#FLIPT_FEATURE_FLAGS.FEED_POST_FILTER')?.argc
    ).toBe(2);
  });

  it('still addresses sites as file#flag, by an enclosing declaration it can name', () => {
    // Named separately from the pair above because a scanner emitting a constant or undefined key
    // fails THAT test with `expected undefined to be 3` — a message about argument counts, which
    // sends the reader nowhere near the key. This one says what actually broke.
    const byKey = new Map(calls.map((c) => [c.key, c]));
    expect(
      byKey.has('server/services/image.service.ts#FLIPT_FEATURE_FLAGS.FEED_POST_FILTER'),
      'ledgerKey no longer produces `file#flag`, so every row in the ledger addresses nothing.'
    ).toBe(true);
    expect(
      byKey.get('server/services/image.service.ts#FLIPT_FEATURE_FLAGS.FEED_POST_FILTER')?.enclosing,
      'the enclosing-declaration parser no longer names this site, so every ledger row that ' +
        'names a function is addressing nothing.'
    ).toBe('searchImages');
  });

  it('adds no Flipt evaluation that names an entity but passes no context', () => {
    const unledgered = calls
      .filter((c) => c.argc === 2 && !(c.key in ENTITY_WITHOUT_CONTEXT_LEDGER))
      .map((c) => c.site)
      .sort();
    expect(
      unledgered,
      'A Flipt evaluation passes an entityId with no evaluation context. Every identity, ' +
        'tier and cohort segment in flipt-state is a STRING_COMPARISON_TYPE constraint, ' +
        'which reads the CONTEXT and never the entityId — so this evaluation cannot match ' +
        'any of them, and returns the flag default instead. That is indistinguishable from ' +
        '"the subject is not in the segment". Pass `buildFliptContext(user)`, or the ' +
        'properties you actually know; if the flag genuinely has no segment rollout, add ' +
        'the site to ENTITY_WITHOUT_CONTEXT_LEDGER with the reason you checked, keyed by ' +
        'file#flag and naming the enclosing function.'
    ).toEqual([]);
  });

  it('keeps the ledger honest — a fixed or deleted site must be removed from it', () => {
    // The direction that gets left out. Without it the ledger silently becomes a
    // list of exceptions that are no longer there, and the next reviewer reads
    // six accepted judgements that describe nothing.
    const bare = new Set(calls.filter((c) => c.argc === 2).map((c) => c.key));
    const stale = Object.keys(ENTITY_WITHOUT_CONTEXT_LEDGER)
      .filter((key) => !bare.has(key))
      .sort();
    expect(
      stale,
      'A ledgered file+flag no longer passes an entityId without a context. Either it was ' +
        'fixed or deleted — drop its row — or the flag expression was respelled, or the file ' +
        'was moved or split, in which case re-key the row. (A line number moving is no longer ' +
        'this test’s business.)'
    ).toEqual([]);
  });

  it('forgives only the declarations a row NAMES, so a new or swapped site is not pre-forgiven', () => {
    // A row keyed on file+flag would otherwise forgive every site in that file evaluating that
    // flag, including ones nobody reviewed. A cardinality would not be enough either: swapping one
    // ledgered site for a new one keeps the number. So the row names the declarations, and this
    // compares that set both ways.
    const bareByKey = new Map<string, EvalCall[]>();
    for (const c of calls.filter((c) => c.argc === 2)) {
      bareByKey.set(c.key, [...(bareByKey.get(c.key) ?? []), c]);
    }
    const describeFound = (found: EvalCall[]) =>
      found.map((c) => `${c.enclosing} (${c.site})`).join(', ') || '(none)';
    const wrong = Object.entries(ENTITY_WITHOUT_CONTEXT_LEDGER)
      .map(([key, row]) => ({ key, row, found: bareByKey.get(key) ?? [] }))
      .filter(
        ({ row, found }) =>
          [...row.fns].sort().join('|') !==
          found
            .map((c) => c.enclosing)
            .sort()
            .join('|')
      )
      .map(
        ({ key, row, found }) =>
          `${key}: ledger names ${[...row.fns].sort().join(', ')}; found ${describeFound(found)}`
      )
      .sort();
    expect(
      wrong,
      'The context-less evaluations in a ledgered file+flag are no longer the ones its row ' +
        'names. A NEW or MOVED site is NOT covered by the existing reason — check the flag still ' +
        'has no segment rollout AND that the reason applies to this site verbatim, then add its ' +
        'declaration. If one was fixed or removed, drop its name.'
    ).toEqual([]);
  });

  it('refuses to forgive a site whose enclosing declaration it could not name', () => {
    // 🔴 `<unattributed>` must FAIL, never forgive. A row covering a site the parser could not
    // name is the cardinality bug again with more steps — the ledger would say which functions it
    // reviewed while silently standing for one it cannot point at.
    //
    // A call nested inside a closure is attributed to the top-level declaration containing it,
    // which is what a row should name; this fires for a call with no declaration before it at all.
    const unnamed = calls
      .filter((c) => c.argc === 2 && c.enclosing === '<unattributed>')
      .map((c) => c.site)
      .sort();
    expect(
      unnamed,
      'A context-less Flipt evaluation has no top-level declaration before it — it sits at ' +
        'module scope, or in a shape the parser does not handle. It CANNOT be ledgered as-is: ' +
        'move the call under a named declaration, or teach the parser that shape. Do not widen ' +
        'a row to swallow it.'
    ).toEqual([]);
  });

  it('ledgers only a real flag constant or a literal, never a computed key', () => {
    // A computed first argument (`isFlipt(flagFor(area), id)`) is ONE key standing for N runtime
    // flags, and the set can grow with no source change here at all — so no assertion in this file
    // could notice. Reading the enum from source rather than importing it keeps this a source gate
    // with no module side effects, and catches an enum member renamed out from under a row.
    const members = new Set(
      [
        ...readFileSync(path.join(SRC, 'server/flipt/client.ts'), 'utf8').matchAll(
          /^\s{2}([A-Z][A-Z0-9_]*)\s*=\s*'/gm
        ),
      ].map((m) => m[1])
    );
    expect(
      members.size,
      'no FLIPT_FEATURE_FLAGS members were read from client.ts — the reader broke, so the check ' +
        'below would pass vacuously'
    ).toBeGreaterThan(40);
    const bad = Object.keys(ENTITY_WITHOUT_CONTEXT_LEDGER)
      .map((key) => ({ key, expr: key.slice(key.indexOf('#') + 1) }))
      .filter(({ expr }) => {
        if (/^'[^']*'$/.test(expr) || /^"[^"]*"$/.test(expr)) return false;
        const m = /^FLIPT_FEATURE_FLAGS\.([A-Z][A-Z0-9_]*)$/.exec(expr);
        return !m || !members.has(m[1]);
      })
      .map(({ key }) => key)
      .sort();
    expect(
      bad,
      'A ledger row is keyed on something that is not a known FLIPT_FEATURE_FLAGS member or a ' +
        'string literal. Either the member was renamed — re-key the row — or the site passes a ' +
        'COMPUTED key, which cannot be ledgered, because one row would forgive every flag that ' +
        'expression can produce and nothing here could see the set grow.'
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
