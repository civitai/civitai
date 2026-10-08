import { readFileSync, readdirSync, statSync, globSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ALL_THREADED_SPELLINGS,
  blankComments,
  callSites,
  topLevelPropertyText,
} from '~/test-utils/routerSourceRegions';
import { OWNER_VISIBLE_INVOCATION_FILTER } from '~/server/services/blocks/scope-activity-predicate';

/**
 * 🔴 THE CROSS-FILE LEDGER FOR THE PRIVATE-RUN AUDIT MARKER.
 *
 * ── THE PRODUCT PROPERTY IT PROTECTS ────────────────────────────────────────────
 * A private run is a moderator (or the app's owner, or an accepted listing collaborator)
 * running a DELISTED / suspended App Block's already-deployed bundle so a takedown can be
 * diagnosed or appealed. The operator decision is that such a run must be invisible to that
 * app's owner INCLUDING IN ANALYTICS — a visible review run tells a bad actor exactly when
 * review is happening.
 *
 * A `block_scope_invocations` row carries the app's REAL id and the viewer's REAL user id,
 * deliberately: a synthetic id would break per-app storage namespacing, the ban-revocation
 * instance id and every runtime metric label. So the row lands squarely inside the
 * `appBlockId IN (ownedIds)` aggregates that `app-analytics.service.ts` serves to the owner,
 * and the ONLY thing that keeps it out is the `source` marker this guard ledgers.
 *
 * ── WHY A LEDGER AND NOT A UNIT TEST ────────────────────────────────────────────
 * 🔴 A FIELD THAT EXISTS IN A DTO IS NOT A GUARD — ONLY A BRANCH ON IT IS, and the branch
 * here lives in ONE place (`recordScopeInvocation` maps the claim to the column value)
 * while the claim must arrive from NINE call sites across FOUR files. Every one of those is
 * a place the optional field can be silently omitted: the call type-checks (the field must
 * be optional so existing callers are unaffected), the writer keeps its branch, the
 * behavioural suites stay green — and the marker is simply absent on that path. That is the
 * "verified in isolation" shape: the writer and the reader are each tested, and the defect
 * lives in the seam neither owns.
 *
 * So this pins a RELATIONSHIP over a whole population: the set of `recordScopeInvocation`
 * call sites, with per-file counts so it fails when the set GROWS (a new writer added
 * without the marker) as well as when it SHRINKS.
 *
 * 🔴 AND THE FILE SET IS DISCOVERED BY WALKING `src/`, NOT TAKEN FROM `LEDGER` — because
 * an earlier revision of this paragraph claimed the population was "derived by walking the
 * tree" while the implementation read five HARDCODED paths, and a review lane caught the
 * gap. Under the hand-listed version, a `recordScopeInvocation` call added in a NEW file —
 * the mint route, a shared-storage writer — left BOTH ledgers green and every private-run
 * call on that path wrote an unmarked row into the owner's aggregates. The instrument
 * control could not see it either: proving five listed files load says nothing about a
 * sixth. `discoverWriterFiles()` below is what makes the docblock's own sentence true, and
 * the per-file counts are then a second, narrower claim on top of it.
 *
 * ── THE ONE EXEMPTION, AND WHY IT IS STRUCTURAL RATHER THAN ASSERTED ────────────
 * The external-OAuth audit writer is exempt: it records a standard OAuth ACCESS token's
 * call, which can never carry a block-token claim, and it writes no `appBlockId` at all, so
 * its row cannot appear in any owner aggregate. That justification is not taken on trust —
 * the exemption case below reads the site and requires both halves of it to still be true.
 *
 * ── RELATIONSHIP TO THE SIBLING GUARD ───────────────────────────────────────────
 * `no-unthreaded-private-run-claim.test.ts` also governs this router's five sites, because
 * its TOTAL assertion counts every threading in `blocks.router.ts` and would otherwise be
 * wrong. The overlap is deliberate and the cost is stated: adding a router writer means
 * bumping a count in two files. This file is the one that closes the population across ALL
 * four files; that one is the one that keeps the router's total honest.
 *
 * ── WHAT THIS DOES *NOT* CLOSE ──────────────────────────────────────────────────
 * Two layers with DIFFERENT blind spots, which is deliberate. The discovery walk matches the
 * bare `recordScopeInvocation(`, so it sees a call however its argument object is formatted;
 * the per-site slicing matches `recordScopeInvocation({` and cannot read a call whose object
 * starts on the next line. So a reformatted call is DISCOVERED but not SLICED, and the
 * per-file bare-vs-slice equality case is what turns that disagreement into a red test
 * instead of a silent hole.
 *
 * Genuinely open, with no instance today: a call reached through an ALIASED import
 * (`recordScopeInvocation as log`) or written with an explicit type argument
 * (`recordScopeInvocation<T>({`) is invisible to both layers, because both key on the
 * literal function name.
 *
 * And it says nothing about whether the marker VALUE is right; that is the behavioural half,
 * in `blocks/__tests__/record-scope-invocation-private-run.test.ts`.
 */

const OPENER = 'recordScopeInvocation({';

/**
 * 🔴 IMPORTED, NOT RE-DECLARED — but the SET is per-consumer, and the history is worth
 * carrying because the two fixes point opposite ways.
 *
 * These were first declared twice with DIFFERENT members over the same router text, so a
 * writer using the third spelling passed here, went uncounted there, and reddened the
 * sibling file with a message naming the wrong fix. The fix was one shared list — which then
 * LOOSENED the sibling, the stricter of the two, from two accepted spellings to three.
 *
 * ⚠️ SO THE WRONG-FIX-MESSAGE HAZARD IS MITIGATED, NOT REMOVED, AND SAYING SO IS THE POINT.
 * A router writer using the storage-only spelling still reddens the sibling's exact total
 * with "add it to LEDGER" — but it ALSO reddens that file's per-site check, which names the
 * two accepted router spellings, so the reader is told the right thing somewhere. Zero
 * instances today. The trade was taken deliberately: a guard that is too permissive is worse
 * than one whose failure message needs a second line read.
 *
 * Each ledger composes its own set from ONE definition of each string; the non-overlap
 * property both exact totals rest on is proven in `routerSourceRegions`' own test.
 */
// The WIDER set: the router's two plus the storage path's verified local, whose provenance
// is ledgered separately below because the string alone says nothing about where the value
// came from. A strict superset of the router ledger's set, so that ledger can never be the
// more permissive of the two.
const THREADED_SPELLINGS = ALL_THREADED_SPELLINGS;

/**
 * Every file that writes a `block_scope_invocations` row, with the site count and why the
 * file is in the set.
 *
 * 🔴 THE COUNTS ARE THE POINT. If you are here because a count is off by one, the fix is to
 * MARK the new call site, not to bump the number.
 */
const LEDGER = [
  {
    file: 'src/server/middleware/block-scope.middleware.ts',
    count: 1,
    why:
      'THE BROADEST SITE. One write per scope-gated REST call, for every wrapped route. An ' +
      "omission here leaks the entire REST surface into the delisted app owner's analytics " +
      'rather than one path.',
  },
  {
    file: 'src/server/routers/blocks.router.ts',
    count: 6,
    why:
      'The tRPC bridge paths: the block-post writer plus the five workflow-submit arms ' +
      '(txt2img, registry step, custom comfy, pass-through, training). These do NOT pass through the ' +
      'REST middleware, so the middleware site above does not cover them.',
  },
  {
    file: 'src/server/services/apps/app-storage.service.ts',
    count: 2,
    why:
      'The storage set + delete writers. 🔴 A REST storage write produces TWO audit rows — ' +
      "this one and the middleware's access row — so marking only one still leaves an " +
      'unmarked row in the owner aggregates.',
  },
  {
    file: 'src/server/services/blocks/user-settings.service.ts',
    count: 1,
    why: 'The viewer-settings write, reachable under any private-run token.',
  },
  {
    file: 'src/server/services/oauth/oauth-scope-audit.ts',
    count: 1,
    exempt: true,
    why:
      'EXEMPT. Records an EXTERNAL OAuth access token call: it can never carry a block-token ' +
      'claim, and it writes no `appBlockId`, so the row cannot reach any owner aggregate. ' +
      'Both halves of that reasoning are re-checked below rather than trusted.',
  },
] as const;

/** Where the marker's single spelling lives, so this guard and the code cannot disagree. */
const PREDICATE_MODULE = 'src/server/services/blocks/scope-activity-predicate.ts';

/**
 * 🔴 THE CARRIER, AND IT CLOSES A MUTANT THAT SURVIVED THE WHOLE SUITE.
 *
 * Two of the eleven writers — the storage set and delete audit rows — never see the claims
 * object, so they thread a LOCAL destructured off the resolver that verified the token. The
 * accepted-spellings list admits that local by name, which means the per-site check above
 * accepts `privateRun: privateRun === true` without tracing where `privateRun` came from —
 * precisely the "a local that has drifted from the claim" case the spellings docblock
 * disclaims.
 *
 * Measured: flipping `resolveStorageContext`'s two returns to `privateRun: false` left the
 * suite at 65/65 green, and 255/255 over a much wider set. Both REST storage audit rows then
 * land UNMARKED on every private run, so the leak survives across the entire REST storage
 * path with nothing red. A review lane found it by mutation; no assertion could have.
 *
 * So the local's PROVENANCE is ledgered here: the resolver must derive it from the verified
 * claim on every return path, and each writer must take it from that resolver rather than
 * from anything else.
 *
 * ⚠️ AN EARLIER REVISION OF THIS PARAGRAPH CITED A BEHAVIOURAL SUITE AT
 * `apps/__tests__/app-storage.private-run-marker.test.ts` THAT DOES NOT EXIST, which is the
 * worst kind of sentence to leave in a guard: it reads as a reassurance that the other half
 * is covered and stops the next person looking. It is not covered behaviourally — both
 * writers sit behind a real Postgres client and a provisioner, so reaching them needs a
 * fixture this segment does not have. This structural ledger is the WHOLE coverage of the
 * storage seam, and that is stated rather than implied.
 */
const STORAGE_CARRIER = {
  file: 'src/server/services/apps/app-storage.service.ts',
  /** The resolver that performs the ONE token verification on the storage path. */
  resolver: 'async function resolveStorageContext',
  /** How many of its return statements must carry the claim — one per resolve branch. */
  returns: 2,
  /**
   * The two writers, BY NAME. 🔴 Naming them is the correction: the first version of the
   * consumer-side assertion counted `'} = await resolveStorageContext('` file-wide and
   * required at least 2 — which the three READ paths (`get`, `list`, `getQuota`) satisfy on
   * their own, because both WRITERS wrap their destructure differently. So the assertion's
   * stated relationship was asserted about nothing, and would have stayed green with both
   * writers re-pointed at a local. It also moved with a pure Prettier reformat, hidden
   * behind a `>=`. Per-writer regions cannot do either.
   */
  writers: [
    'export async function setAppStorageValue',
    'export async function deleteAppStorageValue',
  ],
} as const;

/** The owner-visible reads that must carry the exclusion, and how many of them there are. */
const ANALYTICS_MODULE = 'src/server/services/blocks/app-analytics.service.ts';
const OWNER_VISIBLE_PRISMA_READS = 4;

const read = (rel: string) => blankComments(readFileSync(path.join(process.cwd(), rel), 'utf8'));

/**
 * 🔴 EVERY NON-TEST FILE UNDER `src/` THAT CALLS THE WRITER, DISCOVERED RATHER THAN LISTED.
 * This is what closes the population: `LEDGER` is then checked AGAINST this, so a writer in
 * a file nobody ledgered is red instead of invisible.
 *
 * Comments are blanked before matching, so a docblock that merely NAMES the call — there
 * are several — cannot manufacture a phantom file. Test files are excluded because they
 * legitimately call the writer to test it; a new test is not a new production writer.
 *
 * ⚠️ `globSync` here, not a `grep -r`: this repo's interactive `grep` honours `.gitignore`,
 * and a walk that silently skips a path returns a reassuring zero.
 *
 * 🔴 IT MATCHES THE BARE `recordScopeInvocation(`, NOT the `({` opener, so a call
 * reformatted onto the next line is still DISCOVERED even though `callSites` cannot slice
 * it. The two checks then disagree loudly — the file is ledgered, its per-file bare-vs-slice
 * equality case goes red — instead of the call vanishing from both.
 *
 * 🔴 AND THE DECLARATION IS SUBTRACTED, not matched. `export async function
 * recordScopeInvocation(` contains the same text, so the first version of this walk
 * "discovered" the module that DEFINES the writer and calls it nowhere. Counting total
 * occurrences minus declarations, rather than excluding that path by name, keeps the check
 * honest in the dangerous direction: if a real call is ever added inside the definer, the
 * remainder is non-zero and the file must be ledgered like any other.
 */
const CALL_TOKEN = 'recordScopeInvocation(';
const DECL_TOKEN = 'function recordScopeInvocation(';

/** How many CALLS (not declarations) of the writer a source text contains. */
function callCount(source: string): number {
  const total = source.split(CALL_TOKEN).length - 1;
  const decls = source.split(DECL_TOKEN).length - 1;
  return total - decls;
}

/**
 * 🔴 THE COMPLETE `privateRun` PROPERTY VALUES in a chunk of source, so a check can require
 * one to be EXACTLY an accepted spelling rather than merely to START with one.
 *
 * ⚠️ THIS EXISTS BECAUSE A SUBSTRING TEST LEFT THE ROUND-1 LEAK WALKABLE. Every threading
 * assertion used `includes(spelling)`, so
 * `privateRun: claims.privateRun === true && claims.reviewRunForReal === true` counted and
 * passed at every site — including the storage resolver whose two mutants round 1 closed
 * "by name". `&& someFlag` is not contrived: these docblocks repeatedly say the remaining
 * rails must close "before the flag is enabled", and an ANDed gate is exactly how someone
 * would stage that. Neither the count nor the `not.toContain('privateRun: false')` negative
 * fires on it. Matching the whole RHS is what closes the class rather than one instance.
 *
 * ⚠️ AND IT MUST NOT STOP AT A NEWLINE, WHICH IS A CORRECTION — the first version did, and
 * its docblock claimed the opposite ("a value that spans further fails closed"). It does
 * not: a continuation like
 *
 *     privateRun: claims.privateRun === true
 *       && SOME_ROLLOUT_FLAG,
 *
 * is valid TypeScript, is exactly the ANDed staging gate this guard exists to catch, and
 * truncated to precisely an accepted spelling — so it FAILED OPEN and the round-1 storage
 * mutant was walkable a third time. Prettier would normally put the `&&` at end-of-line,
 * which does fail closed; resting the guarantee on a formatter the docblock never named is
 * the actual defect.
 *
 * So the value is scanned to the first `,` or `}` at DEPTH ZERO, across newlines, tracking
 * bracket depth. A value with unbalanced brackets runs to the end of the chunk and is
 * reported as not-an-accepted-spelling, i.e. it fails closed.
 */
function privateRunValues(source: string): string[] {
  const values: string[] = [];
  const re = /privateRun:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']') depth -= 1;
      else if (c === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (c === ',' && depth === 0) break;
    }
    values.push(source.slice(start, i).trim());
    re.lastIndex = i;
  }
  return values;
}

/** Does this chunk carry a `privateRun` property whose WHOLE value is an accepted spelling? */
function hasExactThreading(source: string): boolean {
  return privateRunValues(source).some((v) =>
    THREADED_SPELLINGS.some((t) => t === `privateRun: ${v}`)
  );
}

/**
 * 🔴 THE EXCLUSION VOCABULARY, AS DATA — the one thing that decides what this ledger covers.
 *
 * ── WHY IT IS A LIST AND NOT A PREDICATE (OR TWO) ───────────────────────────
 * ⚠️ FOUR CONSECUTIVE REVIEW ROUNDS FOUND A HOLE IN THE PREVIOUS SHAPES, ALL THE SAME ONE:
 * the coverage check audited the walk with something the walk produced, so NARROWING the
 * scan narrowed the expectation with it and the gate stayed green with an unmarked writer
 * live. A threshold had slack; a hand-picked directory list was satisfied by a glob matching
 * the list; reading the raw glob was a claim about the pattern rather than the scan; filtering
 * the expectation through the scan's own predicate moved both sides together; two "deliberately
 * independent" twin predicates were re-merged by a delegating one-liner; and a behavioural
 * sample drawn from the scan's output could not test a path the predicate had just excluded.
 *
 * Every one of those tried to DETECT a narrowing after the fact. The narrowing is an edit to
 * this list, so the list is pinned instead — as a literal, in the case below. Adding a
 * conjunct, changing a pattern or dropping one is red immediately and by name, and there is
 * nothing left to sample, derive or cross-audit. One declaration, one predicate built from it,
 * used by both enumerations.
 *
 * ── WHAT IS EXCLUDED, AND WHY EACH ──────────────────────────────────────────
 *   · `/__tests__/` and a `.test`/`.spec` suffix — a test legitimately calls the writer to
 *     test it; a new test is not a new production writer.
 *   · `src/tests/` — a test tree whose helpers carry no suffix. No instance calls the writer,
 *     but one would redden the ledger with "add each to LEDGER and thread the verified claim",
 *     which is a red test naming the wrong fix.
 */
const WRITER_SCAN_EXCLUSIONS = [/\/__tests__\//, /^src\/tests\//, /\.(test|spec)\.tsx?$/] as const;

/** The ONE predicate, built from that list, used by BOTH enumerations. */
const isProductionSource = (file: string) =>
  /\.tsx?$/.test(file) && !WRITER_SCAN_EXCLUSIONS.some((rx) => rx.test(file));

function discoverWriterFiles(): {
  onDisk: string[];
  globbed: string[];
  candidates: string[];
  scannedFiles: string[];
  found: string[];
} {
  // 🔴 ENUMERATED WITH `readdirSync`, NOT `globSync`, AND THE SWAP CLOSED A REAL BLIND SPOT
  // THAT THIS FILE'S OWN VOLUME ASSERTION FOUND. `globSync` skips DOT-DIRECTORIES: measured,
  // it missed `src/pages/api/.well-known/openid-configuration.ts` — one file, but the hole is
  // a whole naming convention, and a writer added under any dot-directory would have been
  // invisible to this ledger. `readdirSync` sees them. The instrument that decides what MUST
  // be read has to be the complete one.
  const onDisk = readdirSync(path.join(process.cwd(), 'src'), {
    recursive: true,
    encoding: 'utf8',
  }).map((f) => `src/${String(f).replace(/\\/g, '/')}`);

  // `candidates` IS THE SET THAT MUST BE READ, so it carries every LEGITIMATE exclusion: test
  // files, non-TypeScript, and paths that are not regular files. The last is not hypothetical
  // — `src/components/ActionIconInput.tsx` is a DIRECTORY whose name ends in `.tsx`, so it is
  // enumerated and `readFileSync` would raise EISDIR.
  const candidates = onDisk.filter(
    (f) =>
      isProductionSource(f) &&
      statSync(path.join(process.cwd(), f), { throwIfNoEntry: false })?.isFile() === true
  );

  // 🔴 THE SECOND, INDEPENDENT ENUMERATION, kept as a lower bound on what the walk read.
  // Narrowing the `readdirSync` walk above leaves these files behind, and the subset assertion
  // in the coverage case then names them.
  //
  // ⚠️ TWO PATTERNS, AND THE SECOND ONE IS THE WHOLE POINT. An earlier revision used
  // `src/**/*.{ts,tsx}` alone and claimed in this very comment that the glob's dot-directory
  // blindness "can never cause a file to go UNCHECKED, only to go uncross-checked." That was
  // FALSE, and it was false about the one file whose discovery motivated rebuilding this walk:
  // uncross-checked IS how it goes unchecked, because no other assertion covers it. Measured —
  // appending `&& !file.includes('/.')` to the walk's predicate left the whole 864-test gate
  // green with an unmarked writer live in `src/pages/api/.well-known/`.
  //
  // So the dot region is globbed explicitly, AND AT FIXED DEPTHS. `src/**/*` does not match a
  // leading dot at any segment, and a flag does not exist — but neither does `src/**/.*/**`
  // work, because `**` never pairs with a dot segment: measured, `src/**/.well-known/*.ts`
  // returns 0 for a file `src/pages/api/.well-known/*.ts` returns. A pattern per depth is the
  // only form that reaches them; (b)'s two-way comparison is what reports a depth going unreached.
  const dotPatterns = Array.from(
    { length: 8 },
    (_, depth) => `src/${'*/'.repeat(depth)}.*/**/*.{ts,tsx}`
  ).flatMap((pattern) => [pattern, pattern.replace('/**/', '/')]);
  const globbed = [
    ...globSync('src/**/*.{ts,tsx}', { cwd: process.cwd() }),
    ...dotPatterns.flatMap((pattern) => globSync(pattern, { cwd: process.cwd() })),
  ]
    .map((f) => f.replace(/\\/g, '/'))
    .filter(
      (f, i, all) =>
        all.indexOf(f) === i &&
        isProductionSource(f) &&
        statSync(path.join(process.cwd(), f), { throwIfNoEntry: false })?.isFile() === true
    );
  const found: string[] = [];
  const scannedFiles: string[] = [];
  for (const file of candidates) {
    const abs = path.join(process.cwd(), file);
    if (callCount(blankComments(readFileSync(abs, 'utf8'))) > 0) found.push(file);
    // 🔴 PUSHED LAST, AFTER THE READ — AND THAT ORDER IS THE WHOLE ASSERTION. Pushing it
    // first made `scannedFiles` identical to `candidates` BY CONSTRUCTION, so both coverage
    // comparisons were tautologies for any skip inserted below the push — which is exactly
    // where someone adding a filter would put it, next to the read it filters. Measured: a
    // `continue` one line lower than the push skipped the whole `src/pages` subtree with the
    // full 854-test gate green. Recorded last, this list is what was actually OPENED.
    scannedFiles.push(file);
  }
  // 🔴 RETURNS THE SCANNED FILE LIST, NOT A COUNT, AND THAT IS A CORRECTION. The set equality
  // below compares MATCHES and so cannot tell a whole-tree walk from a subtree that happens
  // to contain the ledgered five. The previous version handed the coverage check the raw
  // `files` glob result — which made that check a claim about the PATTERN, not about what was
  // actually READ: adding one `continue` inside this loop skipped a whole subtree and the
  // check stayed green, measured, with an unmarked writer planted in it. Coverage has to be
  // derived from the files this loop actually opened.
  return { onDisk, globbed, candidates, scannedFiles, found: found.sort() };
}

describe('every block_scope_invocations writer carries the private-run marker', () => {
  it('[INV] every ledgered file loaded and is non-trivial (instrument control)', () => {
    // Without this, a path typo makes every assertion below vacuous over an empty string
    // rather than red. A reassuring zero is indistinguishable from a guard wired to nothing.
    for (const { file } of LEDGER) {
      expect(read(file).length, `${file} must load`).toBeGreaterThan(1_000);
    }
  });

  it('[INV] the walk READ exactly the files the pinned exclusion list implies', () => {
    // 🔴 THE CONTROL THE SET EQUALITY CANNOT BE. Set equality compares MATCHES, so narrowing
    // the walk still equals `LEDGER` in both directions — measured surviving, with an
    // unmarked writer planted under `src/pages/api` invisible to the whole suite.
    //
    // ⚠️ TWO CORRECTIONS, AND BOTH WERE "THE FIX" ONCE.
    //   · A scanned-file THRESHOLD had ~1,500 files of slack, so dropping `src/pages` cleared
    //     it. A count cannot express "no subtree was dropped".
    //   · Per-directory coverage read the raw GLOB result, so it was a claim about the
    //     pattern and not about what was READ: one `continue` inside the walk skipped a whole
    //     subtree with this check still green. It now reads the list of files the walk
    //     actually opened.
    //
    // 🔴 NOTHING HERE IS HAND-PICKED, AND THAT IS THE ONLY VERSION OF THIS CHECK THAT HAS
    // HELD. Naming four directories left hundreds of non-test production files unguarded —
    // `src/utils` and `src/libs` among them, exactly where a shared "record this call" helper
    // would live — and naming seven was walked by a glob narrowed to those seven. Every
    // expectation below is derived from the filesystem, so no list can go stale and no list
    // can be satisfied by a pattern that matches it. (Counts are deliberately not quoted: two
    // earlier revisions cited figures as evidence and both had drifted by the next audit.)
    const { onDisk, globbed, candidates, scannedFiles, found } = discoverWriterFiles();
    const topLevel = (f: string) => f.split('/')[1];

    // 🔴 (a) EVERY CANDIDATE WAS READ, FILE BY FILE. `scannedFiles` is pushed as the LAST
    // statement of the walk's loop, after the read — pushing it first made this a tautology,
    // and a `continue` one line lower skipped a whole subtree with the full gate green.
    expect(
      candidates.filter((f) => !scannedFiles.includes(f)),
      'these production source files were enumerated but never READ — an unmarked writer in ' +
        'any of them is invisible to the ledger below'
    ).toEqual([]);

    // 🔴 (b) THE TWO INDEPENDENT ENUMERATIONS AGREE, FILE BY FILE AND IN BOTH DIRECTIONS.
    // A one-way subset let a narrowed CROSS-CHECK pass silently — measured, excluding
    // `.service.ts` from it removed 257 files from the audit, including 2 of the 5 ledgered
    // writers and the file kind new writers land in, with the gate green. Two-way file
    // equality costs nothing now that the glob is dot-complete: measured, the sets are exactly
    // equal. It also subsumes the old per-subtree comparisons, which existed only because the
    // glob could not see dot-directories.
    expect(
      globbed.filter((f) => !scannedFiles.includes(f)),
      'these files were found by the independent enumeration but the walk never READ them'
    ).toEqual([]);
    expect(
      scannedFiles.filter((f) => !globbed.includes(f)),
      'the independent cross-check can no longer see these files, so it cannot notice the ' +
        'walk narrowing away from them. Widen the glob rather than accepting the loss.'
    ).toEqual([]);

    // 🔴 (c) AND THE EXCLUSION VOCABULARY IS EXACTLY THIS. Every previous shape of this
    // assertion tried to DETECT a narrowed scan; four rounds found a way past each. Narrowing
    // IS an edit to `WRITER_SCAN_EXCLUSIONS`, so it is pinned as a literal — adding a conjunct,
    // changing a pattern or dropping one is red here, by name, with nothing to sample or
    // derive. There is one predicate now, built from this list and used by both enumerations,
    // so there are no twins left to re-merge — and (d) below pins that the predicate really is
    // built from it.
    //
    // If you are here because you added a legitimate exclusion: add it BOTH here and to the
    // list, and say in the docblock why that path cannot hold a production writer.
    expect(
      WRITER_SCAN_EXCLUSIONS.map(String),
      'the set of paths this ledger declines to scan has changed. Every exclusion widens the ' +
        'blind spot for unmarked writers, so each one is pinned — see the constant docblock.'
    ).toEqual(['/\\/__tests__\\//', '/^src\\/tests\\//', '/\\.(test|spec)\\.tsx?$/']);

    // 🔴 (d) AND THE SCAN ACTUALLY USES THAT LIST AND NOTHING ELSE. Pinning the list alone
    // pins the DATA, not the code that reads it: adding `&& !file.startsWith('src/utils/')`
    // to `isProductionSource` narrows the scan without touching the list, and (c) stays green.
    // Measured surviving, with an unmarked writer live in `src/utils`.
    //
    // So the expectation is REBUILT HERE from the pinned list, over the raw enumeration, and
    // compared to what the scan produced. Between them the two assertions are closed: narrow
    // the list and (c) fires; narrow the predicate and this one does. This is the whole of the
    // coverage claim — there is nothing to sample, nothing derived from the scan, and no
    // second predicate to drift.
    const expectedCandidates = onDisk.filter(
      (f) =>
        /\.tsx?$/.test(f) &&
        !WRITER_SCAN_EXCLUSIONS.some((rx) => rx.test(f)) &&
        statSync(path.join(process.cwd(), f), { throwIfNoEntry: false })?.isFile() === true
    );
    expect(
      candidates,
      'the scan did not select exactly the files the pinned exclusion list implies. Something ' +
        'is filtering outside `WRITER_SCAN_EXCLUSIONS` — an unmarked writer in any file ' +
        'missing here is invisible to the ledger below.'
    ).toEqual(expectedCandidates);

    // Instrument controls. Both enumerations must be seeing a tree, or every assertion above
    // is vacuous over an empty list — and the counts are floors well under the real values so
    // ordinary growth never trips them.
    expect(candidates.length, 'the walk must enumerate thousands of files').toBeGreaterThan(3_000);
    expect(globbed.length, 'the cross-check must enumerate thousands of files').toBeGreaterThan(
      3_000
    );
    expect(
      new Set(scannedFiles.map(topLevel)).size,
      'the walk must span many subtrees'
    ).toBeGreaterThan(10);

    // ⚠️ NO DOT-REGION SPECIAL CASE, AND ITS ABSENCE IS DELIBERATE. Two assertions here once
    // required the walk to read dot-directory files and the cross-check to reach them, both
    // resting on ONE unrelated product route (`src/pages/api/.well-known/`) existing.
    // Measured: deleting that route turned this guard PERMANENTLY RED inside
    // `test:lint-rules`, with a message offering no remedy for the legitimate cause — and a
    // permanently-red gate trains people to delete the assertion, which silently restores the
    // hole it was added for. The property rides on (b) instead: the walk enumerates with
    // `readdirSync`, which sees dot-directories, the glob globs that region explicitly, and
    // (b) compares the two file-by-file in both directions. Nothing depends on a particular
    // file existing.
    // The discovery half still has to find something, or the comparison below is about "[]".
    expect(found.length).toBeGreaterThanOrEqual(LEDGER.length);
  });

  it('[INV] the walk blanks comments — a prose-only mention is not a writer', () => {
    // 🔴 THE POSITIVE CONTROL FOR THE BLANKING LEG, which had none — and measured, the
    // blanking is currently a NO-OP over this tree, because no non-test production file
    // mentions the call only in prose. So if it ever regressed, the first failure would read
    // "a new unledgered writer" and point at a COMMENT: a red test naming the wrong fix, the
    // class this ladder already fixed once in a failure message.
    //
    // Built from literals, so it is a property of the pipeline at any ref.
    expect(callCount(blankComments('// await recordScopeInvocation({ statusCode: 200 })'))).toBe(0);
    expect(callCount(blankComments('/* recordScopeInvocation({}) */'))).toBe(0);
    // The discriminating half: real code still counts once blanking has run.
    expect(callCount(blankComments('await recordScopeInvocation({ statusCode: 200 });'))).toBe(1);
  });

  it('[INV] the LEDGER names EVERY file in src/ that calls the writer — discovered, not listed', () => {
    // ⚠️ [INV], MEASURED. The writer-file population predates this change, so the set
    // equality is green at the base ref — ledger completeness, the identical class the
    // sibling file's count assertions were demoted to [INV] for. What is NEW is the
    // DISCOVERY mechanism; what is ASSERTED is an invariant.
    // 🔴 THIS IS THE ASSERTION THAT CLOSES THE POPULATION, and the guard had none until a
    // review lane pointed out that the docblock claimed a tree walk while the code read five
    // hardcoded paths. Without it, a `recordScopeInvocation` call in a NEW file is invisible
    // to BOTH ledgers: `test:lint-rules` stays green and every private-run call on that path
    // writes an unmarked row into the delisted app owner's own analytics.
    //
    // It fails in BOTH directions on purpose. A file that GAINED a writer must be ledgered
    // (and therefore threaded, or explicitly exempted with a reason); a file that LOST its
    // last writer must leave, so the ledger cannot keep asserting a count over a population
    // that no longer exists and read as coverage.
    const discovered = discoverWriterFiles().found;
    const ledgered = LEDGER.map((e) => e.file).sort();
    expect(
      discovered.filter((f) => !ledgered.includes(f)),
      'these files call `recordScopeInvocation` and are in NEITHER ledger. Add each to ' +
        'LEDGER and thread the verified claim — or, if a file genuinely cannot carry a ' +
        'block-token claim, mark it `exempt: true` with the reason, which the exemption ' +
        'case re-derives from its source rather than trusting.'
    ).toEqual([]);
    expect(
      ledgered.filter((f) => !discovered.includes(f)),
      'these files are ledgered but no longer call `recordScopeInvocation`. Remove them, ' +
        'or the per-file count below asserts something about a population that is gone.'
    ).toEqual([]);
  });

  describe.each(LEDGER)('$file', ({ file, count, why, ...rest }) => {
    const exempt = 'exempt' in rest && rest.exempt === true;
    const source = read(file);
    const sites = callSites(source, OPENER);

    it(`[INV] the extractor finds exactly ${count} call site(s) — fails if the set GROWS or SHRINKS`, () => {
      expect(sites, why).toHaveLength(count);
      // EVERY slice must look like a real argument object, not stray text that matched —
      // `statusCode` is a field every writer in the codebase already carries.
      expect(
        sites.filter((s) => !s.includes('statusCode')),
        'every slice must be a real argument object (containing `statusCode`)'
      ).toEqual([]);
    });

    it('[INV] no call site is written `fn(<newline>{` — which would hide it from every other check', () => {
      // 🔴 THE HOLE THAT DEFEATS THIS WHOLE FILE AT ONCE. `callSites` matches the literal
      // `<fn>({`, so a site reformatted as `recordScopeInvocation(\n  {` is not in `sites`
      // at all — invisible to the COUNT (which reads one fewer and could be "fixed" by
      // lowering the number) and to the threading check. Prettier's object-hugging is the
      // only thing preventing it today, which is a convention, not a guard.
      const bare = callCount(source);
      expect(
        bare,
        `recordScopeInvocation( occurs ${bare} times in ${file} but only ${sites.length} ` +
          'are written as `recordScopeInvocation({`.'
      ).toBe(sites.length);
    });

    if (exempt) {
      it('[INV] the exemption is still structurally justified — no appBlockId, external-oauth source', () => {
        // 🔴 AN EXEMPTION IS A CLAIM ABOUT THE CODE, SO CHECK THE CODE. Both halves must
        // hold: if this writer ever gained an `appBlockId` its rows could reach an owner
        // aggregate, and if it stopped tagging `external-oauth` the population would no
        // longer be disjoint from the block-token one. Either change must force a decision
        // here rather than silently widening the exemption.
        for (const site of sites) {
          const top = topLevelPropertyText(site);
          expect(top, 'the exempt writer must still tag external-oauth').toContain(
            "source: 'external-oauth'"
          );
          expect(top, 'the exempt writer must still write no appBlockId').not.toContain(
            'appBlockId'
          );
        }
      });
    } else {
      it('[REG] every call site threads the VERIFIED claim, not a literal', () => {
        // 🔴 CHECKED AT THE ARGUMENT OBJECT'S OWN DEPTH. A `callSites` slice contains nested
        // objects and nested calls, so a slice-wide `includes` is satisfied by a match at
        // ANY depth — e.g. inside the `detail: { … }` object — which is the
        // field-exists-but-nothing-branches-on-it failure one nesting level down.
        // 🔴 `hasExactThreading`, NOT `includes` — see its docblock. A prefix match accepted
        // `… === true && someFlag`, which disables the marker while reading as wired.
        const unthreaded = sites.filter((site) => !hasExactThreading(topLevelPropertyText(site)));
        expect(
          unthreaded,
          `${unthreaded.length} \`${OPENER}\` call site(s) in ${file} do not pass the ` +
            'verified private-run claim as a TOP-LEVEL property. Mark the path rather than ' +
            `exempting it: ${why}`
        ).toEqual([]);
      });
    }
  });

  it('[INV] the EXACT-value filter is real — a prefix does not satisfy the check', () => {
    // 🔴 "I ADDED AN EXACT-VALUE CHECK" AND "THE EXACT-VALUE CHECK WORKS" ARE DIFFERENT
    // CLAIMS. Reverting `hasExactThreading` to the prefix semantics it replaced survived the
    // whole suite, which means nothing was pinning the tightening itself. The sibling
    // depth-filter control below exists for exactly this reason and this one was missing.
    // Built from literals, so it is a property of the function at any ref.
    const good = `privateRun: ${THREADED_SPELLINGS[0].replace('privateRun: ', '')},`;
    expect(hasExactThreading(good)).toBe(true);
    // The ANDed staging gate, inline and across a newline — both are prefixes of nothing
    // accepted, and both must be refused.
    expect(hasExactThreading(`${THREADED_SPELLINGS[0]} && ROLLOUT_ENABLED,`)).toBe(false);
    expect(hasExactThreading(`${THREADED_SPELLINGS[0]}\n  && ROLLOUT_ENABLED,`)).toBe(false);
    // And a literal, which is the other way to disable the marker while reading as wired.
    expect(hasExactThreading('privateRun: false,')).toBe(false);
    expect(hasExactThreading('privateRun: true,')).toBe(false);
  });

  it('[INV] the depth filter is real — a NESTED match does not satisfy the check', () => {
    // 🔴 THE NEGATIVE CONTROL, because "I added a depth filter" and "the depth filter works"
    // are different claims. Built from a LITERAL, not from a real site: mutating a real
    // site's text would make this test depend on the threading already existing, so it
    // would go red at the base ref for a mechanical reason and be mislabelled.
    const t = THREADED_SPELLINGS[0];
    const flat = `${OPENER} statusCode: 200, ${t}, z: 2 }`;
    const nested = `${OPENER} statusCode: 200, detail: { ${t} }, z: 2 }`;
    // A naive slice-wide grep is satisfied by BOTH…
    expect(flat).toContain(t);
    expect(nested).toContain(t);
    // …the depth check accepts only the one where the field is on the object itself.
    expect(topLevelPropertyText(flat)).toContain(t);
    expect(topLevelPropertyText(nested)).not.toContain(t);
  });

  it('[INV] callCount separates a CALL from the DECLARATION (discovery negative control)', () => {
    // 🔴 THE CONTROL FOR THE SUBTRACTION, because "I subtracted declarations" and "the
    // subtraction is right" are different claims — and getting it wrong in the other
    // direction would make the discovery walk find NOTHING and every set comparison above
    // pass vacuously over an empty list. Built from literals, so it is a property of the
    // function at any ref.
    expect(callCount('export async function recordScopeInvocation(opts: {')).toBe(0);
    expect(callCount('await recordScopeInvocation({ statusCode: 200 })')).toBe(1);
    // A definer that ALSO calls it is one call, not zero — the dangerous direction.
    expect(
      callCount('function recordScopeInvocation(o) {} \n await recordScopeInvocation({})')
    ).toBe(1);
    // And the reformatted `fn(<newline>{` shape is still counted as a call, which is what
    // makes it DISCOVERABLE even though `callSites` cannot slice it.
    expect(callCount('await recordScopeInvocation(\n  { statusCode: 200 }\n)')).toBe(1);
  });

  it('[REG] every accepted spelling is actually USED by production code', () => {
    // 🔴 [REG], MEASURED: two of the three spellings are introduced by this PR, so this is
    // red at the base ref. It was labelled [INV] on the strength of "it reads production
    // text, so it must be an invariant" — the same laundering error in the other direction,
    // settled by a base-ref run.
    // 🔴 A PRODUCT CLAIM, NOT A CLAIM ABOUT THIS FILE'S OWN VOCABULARY — which is what the
    // first version of this case was, and a meta-guard of exactly the shape PR 1 added and
    // then deleted after five review rounds. It also doubles as the instrument control the
    // import needs: a truncated shared list would make the per-site checks above fail
    // closed with "this site is not threaded", sending the reader to the wrong file.
    //
    // Each accepted spelling must appear somewhere in the ledgered production files. A
    // spelling nobody uses is dead vocabulary that only widens what the per-site check
    // accepts — and the destructured one is the loosest of the three, so it must earn its
    // place rather than sit there admitting an untraceable local.
    // 🔴 SCOPED TO THE WRITER CALL SITES AND THE CARRIER, not to whole files. "Appears
    // somewhere in one of five files" is much weaker than "a writer uses it": the
    // claims-local spelling also appears at the router's `recordSpendAttribution` money arms,
    // so every `recordScopeInvocation` site could drop it and this case would stay green. The
    // resolver is included because that is where the storage path's local is DERIVED, which
    // is the only legitimate producer of the bare-local spelling.
    const siteText = LEDGER.flatMap((e) => callSites(read(e.file), OPENER))
      .map((site) => topLevelPropertyText(site))
      .join('\n');
    const carrier = read(STORAGE_CARRIER.file);
    for (const spelling of THREADED_SPELLINGS) {
      expect(
        siteText.includes(spelling) || carrier.includes(spelling),
        `no production writer call site — and not the storage carrier either — uses ` +
          `\`${spelling}\`. Remove it from the shared list rather than leaving a spelling ` +
          'the per-site check accepts and nothing produces.'
      ).toBe(true);
    }
  });
});

describe('the storage path carries the VERIFIED claim, not just a local', () => {
  const source = read(STORAGE_CARRIER.file);

  it('[REG] every return of the storage resolver derives privateRun from the verified claim', () => {
    // 🔴 THE ASSERTION THAT KILLS THE SURVIVING MUTANT. `resolveStorageContext` is the only
    // place on this path that holds the claims, so if ANY of its return branches stops
    // deriving the value from `claims.privateRun`, both downstream audit rows go unmarked
    // and every behavioural test still passes — the writers dutifully thread a local that is
    // now a constant.
    const at = source.indexOf(STORAGE_CARRIER.resolver);
    expect(at, `${STORAGE_CARRIER.resolver} must still exist under this name`).toBeGreaterThan(0);
    // Bound the region at the next top-level declaration so this reads the resolver only.
    const after = source.slice(at + STORAGE_CARRIER.resolver.length);
    const nextDecl = after.search(/\n(?:export )?(?:async )?function |\ntype |\nconst /);
    let body = nextDecl === -1 ? after : after.slice(0, nextDecl);

    // 🔴 THE BODY, NOT THE SIGNATURE. The region above starts at the function NAME, so it
    // includes the declared return type — which contains `privateRun: boolean;`. The
    // whole-value matcher correctly refused that as a threading expression, which is the
    // matcher working: a TYPE DECLARATION IS NOT A CODE PATH, and a check that counted it
    // would have been reading the promise rather than the delivery. Slice from the first
    // body statement so only real expressions are in scope.
    const VERIFY = 'const claims = await verifyBlockToken(blockToken);';
    const bodyAt = body.indexOf(VERIFY);
    // Positive control: the region really is the resolver's body, not an empty or wrong
    // slice — without this every assertion below is vacuous over a truncated string.
    expect(bodyAt, 'the resolver must still verify the token as its first act').toBeGreaterThan(0);
    body = body.slice(bodyAt);
    // And the body really does contain the resolve branches the count below is about.
    expect(
      body.split('return {').length - 1,
      'the resolver must still have its resolve branches'
    ).toBe(STORAGE_CARRIER.returns);

    // 🔴 EVERY `privateRun` VALUE IN THE REGION, MATCHED WHOLE. A substring check counted
    // `… === true && claims.reviewRunForReal === true` as threaded, so the round-1 mutant
    // was still walkable at the very site round 1 closed. This asserts the SET of values,
    // which makes both halves one claim: the right number of branches, and nothing else.
    const values = privateRunValues(body);
    expect(
      values,
      `each of the ${STORAGE_CARRIER.returns} resolve branches must carry EXACTLY ` +
        '`privateRun: claims.privateRun === true`. A branch returning a literal, an ANDed ' +
        'expression, or omitting the field silently unmarks BOTH storage audit rows for ' +
        'every private run while the writers still look correctly threaded.'
    ).toEqual(Array(STORAGE_CARRIER.returns).fill('claims.privateRun === true'));
  });

  it.each(STORAGE_CARRIER.writers)(
    '[REG] %s takes privateRun from the resolver, not from anywhere else',
    (writer) => {
      // 🔴 [REG], AND THE LABEL WENT [REG] → [INV] → [REG] ACROSS TWO ROUNDS BECAUSE THE
      // ASSERTION CHANGED UNDER IT. A round-2 measurement found the ORIGINAL form green at
      // the base ref — correctly: it counted destructures file-wide with a `>=`, which the
      // base already satisfied, which is also why it was vacuous. The per-writer form that
      // replaced it requires each writer to destructure `privateRun`, a field the base ref
      // does not have, so it is red there. Re-measured after the rewrite rather than carried
      // over: a label belongs to an assertion, not to a test name.
      // 🔴 THE OTHER END OF THE SEAM, ASSERTED PER WRITER. A writer that computed
      // `privateRun` itself — from a second `verifyBlockToken`, or from a field it happened
      // to have — would satisfy the spelling check above while bypassing the one
      // verification this path performs. Scoped to each writer's own region so the three
      // READ paths cannot stand in for them, which is exactly what the file-wide count this
      // replaces allowed.
      const at = source.indexOf(writer);
      expect(at, `${writer} must still exist under this name`).toBeGreaterThan(0);
      const after = source.slice(at + writer.length);
      const nextDecl = after.search(
        /\n(?:export )?(?:async )?function |\n(?:export )?type |\n(?:export )?const /
      );
      const body = nextDecl === -1 ? after : after.slice(0, nextDecl);

      // Positive control: the region really is this writer's body, not an empty slice — it
      // must contain the audit write the marker rides on.
      expect(body, `${writer}'s region must contain its audit write`).toContain(OPENER);

      // 🔴 THE DESTRUCTURE, MATCHED WITHOUT DEPENDING ON LINE BREAKS. Prettier moves the
      // `= await` across lines depending on the binding list's width, and the first version
      // of this check was pinned to one of those shapes. Collapse whitespace instead.
      const flat = body.replace(/\s+/g, ' ');

      // 🔴 THE NEGATIVE CONTROL FOR THE REGION, ASSERTED ON THE VERY STRING THE CHECKS READ.
      // Reverting `body` to the whole `source` survived the entire suite — every check below
      // still found its string SOMEWHERE in the file, which is precisely the file-wide scope
      // this case replaced and precisely what let the three READ paths stand in for the two
      // writers. A first attempt at this control asserted on `body` and did NOT fire, because
      // the mutation re-points only the variable the assertion uses: a control has to be
      // bound to the same value it is controlling for, or it is testing a different string.
      //
      // A correctly-bounded region contains this writer and nothing else.
      for (const foreign of [STORAGE_CARRIER.resolver, ...STORAGE_CARRIER.writers].filter(
        (n) => n !== writer
      )) {
        expect(
          flat,
          `${writer}'s region is not bounded — it reaches ${foreign}, so every check below ` +
            'is reading the whole file rather than this writer'
        ).not.toContain(foreign);
        expect(body, `${writer}'s region is not bounded — it reaches ${foreign}`).not.toContain(
          foreign
        );
      }

      expect(
        flat,
        `${writer} must destructure \`privateRun\` from \`resolveStorageContext\` — that is ` +
          'the only place on this path that holds the verified claim'
      ).toContain('privateRun } = await resolveStorageContext(');
      // And it must not perform its own verification: a second one is a second place the
      // claim can be read differently.
      expect(
        body,
        `${writer} must not verify the token itself — the resolver already did`
      ).not.toContain('verifyBlockToken(');
    }
  );

  it('[INV] the resolver is the ONLY place this module verifies a token', () => {
    // ⚠️ SCOPED TO THIS MODULE, and the earlier wording was wrong about the PATH. A REST
    // storage call verifies twice — once in `withBlockScope` and once here — which is
    // precisely why the ledger's entry for this file notes that one REST write produces two
    // audit rows. What is asserted is narrower and true: within this module there is one
    // verification, so there is one place the claim is read.
    expect(
      source.split('verifyBlockToken(').length - 1,
      'this module must verify the token exactly once, in resolveStorageContext'
    ).toBe(1);
  });
});

describe('the marker has ONE spelling and every owner-visible read excludes it', () => {
  it('[INV] the marker value and the exclusion predicate are defined exactly once', () => {
    // ⚠️ [INV]: a property of constants THIS PR introduces. Reverting the predicate module
    // makes three of these files fail to IMPORT, so no per-case red/green is measurable at
    // the base ref — which means it must not be reported as regression coverage.
    // 🔴 ONE RULE, ONE PLACE. A second literal `'private-run'` anywhere in the writer or the
    // readers is the drift that makes a filter and a writer disagree while both look right.
    const predicate = read(PREDICATE_MODULE);
    expect(predicate).toContain("export const PRIVATE_RUN_INVOCATION_SOURCE = 'private-run'");
    expect(predicate).toContain('export const OWNER_VISIBLE_INVOCATION_FILTER');
    // The value appears exactly once in the tree outside its own definition module and the
    // tests: as the definition. Everything else must import it.
    const writer = read('src/server/services/blocks/user-app-surface.service.ts');
    const analytics = read(ANALYTICS_MODULE);
    expect(
      writer.split("'private-run'").length - 1,
      'the writer must use PRIVATE_RUN_INVOCATION_SOURCE, never a second literal'
    ).toBe(0);
    expect(
      analytics.split("'private-run'").length - 1,
      'analytics must use the shared predicate, never a second literal'
    ).toBe(0);
  });

  it('[INV] the shared filter constrains ONLY `source` — nothing that could scope a read', () => {
    // 🔴 THE ASSERTION THAT MAKES THE SPREAD ORDER SAFE RATHER THAN MERELY CORRECT TODAY.
    // `appBlockId: idIn` is the only thing scoping those four reads to the caller's own
    // apps, and `satisfies Prisma.BlockScopeInvocationWhereInput` constrains the constant's
    // SHAPE, not which keys it may hold — so a future edit adding `appBlockId` or
    // `invokedAt` to the filter would compile clean and silently widen four aggregates
    // served to app developers. The reads now spread it FIRST so explicit keys win, and
    // this pins the key set so the hazard cannot reappear from the other direction either.
    // Order-independent, and loud on any widening.
    // 🔴 DEEP EQUALITY, NOT `Object.keys`. The key-set pin checked only the TOP level, so
    // `source: { not: MARKER, notIn: ['app-block'] }` passed it — and that widening excludes
    // every ORDINARY row from all four owner aggregates, which is the over-filter direction
    // the whole suite is built around. Measured surviving by a round-2 audit. The literal is
    // spelled out rather than built from the constant so this cannot agree with a wrong
    // constant.
    expect(OWNER_VISIBLE_INVOCATION_FILTER).toEqual({ source: { not: 'private-run' } });
  });

  it(`[REG] all ${OWNER_VISIBLE_PRISMA_READS} Prisma engagement reads spread OWNER_VISIBLE_INVOCATION_FILTER`, () => {
    // 🔴 THE SET MUST STAY COMPLETE. Five owner-visible reads aggregate this table: four
    // Prisma calls (api-call count, error count, top scopes, top endpoints) and one raw
    // `count(DISTINCT user_id)`. Miss ONE and the leak survives in whichever number it
    // feeds. Counted structurally because `getMyAppAnalytics` cannot be invoked without a
    // database.
    const analytics = read(ANALYTICS_MODULE);
    const spreads = analytics.split('...OWNER_VISIBLE_INVOCATION_FILTER').length - 1;
    const reads = analytics.split('dbRead.blockScopeInvocation.').length - 1;
    // Positive control: the reads themselves are findable, so a zero below would be a real
    // absence rather than a wrong pattern.
    expect(reads, 'the engagement reads must be findable at all').toBe(OWNER_VISIBLE_PRISMA_READS);
    expect(
      spreads,
      `${reads} Prisma engagement reads exist but only ${spreads} exclude private-run rows`
    ).toBe(OWNER_VISIBLE_PRISMA_READS);
  });

  it('[REG] the Prisma model documents ALL THREE source values', () => {
    // 🔴 THE `///` COMMENT ON THE COLUMN IS NOT A COMMENT — it is the single source for the
    // generated type docs in `packages/civitai-db-schema/src/kysely/types.ts`, i.e. the
    // documentation every future reader of this column is handed. It enumerated two values
    // while the column had three, which is the "a comment is a claim too" failure on the
    // one surface a maintainer is most likely to trust. Pinned so a fourth value cannot
    // land without updating it.
    const schema = readFileSync(
      path.join(process.cwd(), 'packages/civitai-db-schema/prisma/schema.full.prisma'),
      'utf8'
    );
    const at = schema.indexOf('model BlockScopeInvocation {');
    expect(at, 'the model must still exist under this name').toBeGreaterThan(0);
    const model = schema.slice(at, schema.indexOf('\n}', at));
    // Positive control: the region really is the model, not an empty slice.
    expect(model).toContain('@@map("block_scope_invocations")');

    // 🔴 THE `source` COLUMN'S OWN CONTIGUOUS `///` BLOCK, NOT THE WHOLE MODEL. Two OTHER
    // columns' comments mention `'external-oauth'` (the nullable-`oauth_client_id` notes), so
    // a model-wide search was green even after the `source` enumeration itself stopped naming
    // it — measured surviving by a round-2 audit. That is the exact defect this guard exists
    // for, passing off a neighbour's prose.
    const decl = model.indexOf('  source           String');
    expect(decl, 'the source column must still be declared under this shape').toBeGreaterThan(0);
    // ⚠️ `decl` sits at the START of its line, so splitting there leaves a trailing EMPTY
    // element — walking up from it stopped immediately and found zero doc lines, which the
    // slice's own positive control caught. Drop the empty partial before walking.
    const before = model.slice(0, decl).split('\n');
    if (before[before.length - 1].trim() === '') before.pop();
    const docLines: string[] = [];
    for (let i = before.length - 1; i >= 0 && before[i].trim().startsWith('///'); i -= 1) {
      docLines.unshift(before[i]);
    }
    const doc = docLines.join('\n');
    // Positive control for the slice itself: a contiguous comment block was actually found.
    expect(docLines.length, 'the source column must carry its own /// doc block').toBeGreaterThan(
      3
    );
    for (const value of ["'app-block'", "'external-oauth'", "'private-run'"]) {
      expect(doc, `the source column's OWN doc comment must name ${value}`).toContain(value);
    }
    // ⚠️ This pins the AUTHORED comment. The load-bearing surface is the GENERATED
    // `packages/civitai-db-schema/src/kysely/types.ts`, which only `db:check-generated`
    // reconciles — so an edit here without a regen is green in this file and red in CI.
  });

  it('[REG] analytics names `source` ONLY through the shared filter and the raw statement', () => {
    // 🔴 THE MIRROR OF THE SPREAD-ORDER HAZARD, AND THE REASON "spread first" IS NOT ITSELF
    // A FIX. Spreading the filter LAST let the constant win a collision on `appBlockId` —
    // the only thing scoping these reads to the caller's own apps. Spreading it FIRST closes
    // that and opens the inverse: a read that spells `source:` among its own explicit keys
    // now silently REPLACES the exclusion, while the spread count stays 4 and the key pin
    // stays `['source']`. Both guards would be green over an unfiltered read.
    //
    // So the column may be named in exactly two places in this file: the import of the
    // shared constant, and the raw statement that cannot use a spread. Any third mention is
    // a read constraining `source` on its own terms.
    const analytics = read(ANALYTICS_MODULE);
    // Positive control: the raw statement's mention is findable, so a zero is a measurement.
    expect(analytics).toContain('"source" <> ');
    expect(
      analytics.split('source: {').length - 1,
      'no read in this file may constrain `source` with its own object literal — spread ' +
        'OWNER_VISIBLE_INVOCATION_FILTER, which is spread FIRST so explicit keys win'
    ).toBe(0);
  });

  it('[REG] the raw count(DISTINCT user_id) read excludes private-run rows too', () => {
    // The one read the spread above cannot cover: it is raw SQL, so it needs the literal
    // column predicate, parameterised from the same exported constant.
    const analytics = read(ANALYTICS_MODULE);
    const at = analytics.indexOf('count(DISTINCT "user_id")');
    expect(at, 'the distinct-user read must still exist under this shape').toBeGreaterThan(0);
    // 🔴 AND IT MUST BE THE ONLY ONE. `indexOf` takes the FIRST occurrence, so a second
    // distinct-user read added ABOVE this one silently becomes this guard's subject while the
    // live read goes unguarded — and the first failure would land on the DECOY, inviting
    // whoever sees it to update the pin to the decoy. This is the mirror of the bound-slice
    // fix below: that closed "a neighbour BELOW satisfies my needles", this closes "a
    // neighbour ABOVE becomes my subject". A per-scope or last-24h distinct-user read is the
    // realistic trigger.
    expect(
      analytics.split('count(DISTINCT "user_id")').length - 1,
      'more than one distinct-user read exists in this file, so the pin below is about ' +
        'whichever comes FIRST. Give this guard an unambiguous anchor before adding another.'
    ).toBe(1);

    // 🔴 BOUNDED AT THE TEMPLATE'S CLOSING BACKTICK, NOT A 600-CHAR WINDOW. The round-3 fix
    // widened the corpus to `slice(at, at + 600)` while adding the `i` flag, and the
    // statement is only ~280 chars — so every assertion below was also scanning ~320 chars
    // of neighbouring Prisma code. Two live directions: a stray `or` drifting into the window
    // reddens a guard whose message names the raw statement, and a future raw statement
    // added just after this one could satisfy `"app_block_id" IN (` or the range needles from
    // a NEIGHBOUR — this file already has two other statements carrying that exact substring.
    // 🔴 ANCHORED AT THE TEMPLATE'S OPENING BACKTICK, NOT AT THE PROJECTION. Slicing from
    // `count(DISTINCT …)` left the statement's HEAD — everything between the backtick and the
    // projection — read by nothing, so an interpolation inserted before `count(`, or a whole
    // `WITH … AS (…)` prepended, passed every pin while two of them claimed to cover "exactly
    // these expressions, in this order" and "the projection and FROM clause". Neither is a
    // plausible cross-tenant defect on its own, which is why this is a correction to what the
    // guard COVERS rather than a hole — but three rounds running found a comment wider than
    // its code, and anchoring one token earlier costs nothing.
    const open = analytics.lastIndexOf('`', at);
    expect(open, 'the statement must still be a tagged template').toBeGreaterThan(0);
    const window = analytics.slice(open + 1, at + 600);
    const close = window.indexOf('`');
    expect(
      close,
      'the statement must still be a tagged template with a closing backtick'
    ).toBeGreaterThan(0);
    const stmt = window.slice(0, close);

    expect(stmt, 'the distinct-user read must be over the invocations table').toContain(
      '"block_scope_invocations"'
    );

    /**
     * 🔴 THE WHOLE NORMALISED WHERE CLAUSE, PINNED — NOT A LIST OF FORBIDDEN SPELLINGS.
     *
     * ⚠️ THIS IS THE THIRD ATTEMPT AT THIS GUARD, AND THE FIRST TWO FAILED THE SAME WAY, SO
     * THE APPROACH IS THE FINDING. Round 2 pinned `AND "source" <> ` and forbade `/\bOR\b/`;
     * lowercase `or` walked it in one character. Round 3 added the `i` flag and forbade
     * `/NOT\s+IN\s*\(/i`; `WHERE NOT "app_block_id" IN (…)` walked THAT — in Postgres `NOT`
     * binds looser than `IN`, so it is the same cross-tenant inversion with the two tokens
     * separated by the column name. `(… IN (…)) IS NOT TRUE` walked it too. Each round
     * forbade the spelling it had just seen, and the next respelling was one edit away.
     *
     * 🔴 AND THE BEHAVIOURAL SHIM SHARED THE BLIND SPOT, so it was never a second opinion:
     * it keyed negation off the same `/NOT\s+IN\s*\(/i` regex. A structural guard and a
     * behavioural guard that test the same predicate are ONE guard.
     *
     * A guard on WORDS is walkable by REWORDING; the artifact here is prose, so the whole
     * normalised string is what gets pinned. Every respelling of the boolean shape — a
     * disjunction in any case, a negation in any position, an `IS NOT TRUE` wrapper, a
     * dropped range bound, a reordered term — is now one diff away from a failure, and the
     * cost is that a cosmetic reformat of this statement fails this test. That is the price
     * of a machine-readable claim, and it is worth paying on the one read in this PR whose
     * mutations are cross-tenant.
     */
    const normalised = stmt.replace(/\s+/g, ' ').trim();

    // 🔴 THE WHOLE `WHERE` CLAUSE, WITH INTERPOLATIONS COLLAPSED. Every disjunction,
    // negation, `IS NOT TRUE` wrapper, dropped bound and reordered term fails this, because
    // it is an exact match on the clause's shape.
    //
    // ⚠️ COLLAPSED RATHER THAN VERBATIM, AND THAT IS A CORRECTION OF THE COST, NOT OF THE
    // GUARANTEE. The previous revision pinned the whole statement verbatim and its docblock
    // said "the cost is that a cosmetic reformat of this statement fails this test" — which
    // is FALSE for the commonest reformat there is: `replace(/\s+/g, ' ')` erases a reindent.
    // The cost it actually charged was renaming an interpolated expression (`ownedIds` →
    // `ownedAppIds`), which is a refactor with nothing to do with the boolean shape. So the
    // paragraph justified the trade by naming a cost the guard did not charge and omitting
    // the one it did. Collapsing `${…}` to `?` keeps every shape guarantee and drops that
    // churn; the two claims are separated so a failure names WHICH one broke.
    const shape = normalised.slice(normalised.indexOf('WHERE ')).replace(/\$\{[^}]*\}/g, '?');
    expect(
      shape,
      'the WHERE clause must match this shape EXACTLY. Every term is a restriction AND-ed to ' +
        'the next: the ownership bound over the joined owned ids, both range bounds, and the ' +
        'private-run exclusion. A disjunction or a negation ANYWHERE in it reads one owner ' +
        'every distinct user of every app in the table — worse than the leak this PR closes.'
    ).toBe(
      'WHERE "app_block_id" IN (?) AND "invoked_at" >= ? AND "invoked_at" <= ? ' +
        'AND "source" <> ?'
    );

    // 🔴 AND WHICH VALUE LANDS IN WHICH SLOT, IN ORDER — because the collapse above cannot see
    // inside a `?`, AND THAT COST A GATED REGRESSION. The previous revision asserted only the
    // ownership placeholder, which left the two RANGE placeholders interchangeable: swapping
    // them to `>= ${range.to}` / `<= ${range.from}` keeps the collapsed shape byte-identical,
    // typechecks (both are `Date`), and inverts the window so the read returns nothing.
    //
    // ⚠️ THE TIER MATTERS AS MUCH AS THE ASSERTION. That swap WAS caught before the collapse,
    // by this very guard, which runs in `test:lint-rules`. Afterwards it was caught only by
    // `blocks/__tests__/app-analytics.private-run-exclusion.test.ts` — a behavioural suite
    // that is NOT in that selector. So the collapse moved a real statement defect from the
    // gated tier into the ungated one, and the commit that made the trade cited a
    // `test:lint-rules` count as its evidence: a green claim about a tier that had stopped
    // looking.
    //
    // Pinning the ORDERED list of interpolated expressions restores it. This is the one claim
    // that does charge a rename of `range` or `ownedIds` — stated plainly, unlike the
    // reformat cost the previous revision invented for itself.
    expect(
      [...normalised.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]),
      'the statement must interpolate exactly these expressions, in this order. The shape ' +
        'check above collapses every `${…}` to `?`, so it cannot tell `>= from AND <= to` ' +
        'from `>= to AND <= from` — same shape, inverted window, empty result. If you renamed ' +
        'one of these, update this list; if you REORDERED them, do not.'
    ).toEqual(['Prisma.join(ownedIds)', 'range.from', 'range.to', 'PRIVATE_RUN_INVOCATION_SOURCE']);

    // 🔴 AND THE PROJECTION AND TABLE, which the `WHERE`-onward slice stopped covering. Not a
    // hole today — the table name is asserted above and the anchor pins the projection — but
    // the previous revision narrowed the pin's scope without saying so, and an aliased table
    // (`FROM "block_scope_invocations" AS i`) went from red to green in that change.
    expect(
      normalised.slice(0, normalised.indexOf('WHERE ')).replace(/\s+$/, ''),
      "everything before the WHERE clause is part of this read's shape too — the projection, " +
        "the FROM, and the statement HEAD. Anchored at the template's opening backtick so a " +
        'prepended CTE, or an interpolation inserted before the projection, cannot slip past.'
    ).toBe('SELECT count(DISTINCT "user_id")::bigint AS value FROM "block_scope_invocations"');
  });

  /**
   * 🔴 THE THREE SELF-SCOPED READS, BY THE FUNCTION THAT OWNS EACH. Keyed on `userId` — a
   * viewer looking at their OWN rows.
   *
   * ⚠️ REGIONS, NOT WHOLE FILES, AND THAT IS A CORRECTION MY OWN ASSERTION CAUGHT. A
   * file-wide grep for the marker constant reddens immediately on
   * `user-app-surface.service.ts`, because that file also contains the WRITER — the one
   * legitimate use of the constant in the codebase. Scoping to each read's own body is what
   * makes the claim checkable instead of self-contradictory; it is the same
   * region-not-file lesson as the storage-writer ledger above.
   */
  const VIEWER_OWN_READS = [
    {
      file: 'src/server/services/blocks/user-app-surface.service.ts',
      fn: 'async function listAppBlocksThatActedOnUser',
      why: "the viewer's permissions tab — which apps acted on ME",
    },
    {
      file: 'src/server/services/blocks/user-app-surface.service.ts',
      fn: 'export async function listMyScopeInvocations',
      why: "the viewer's own Activity feed",
    },
    {
      file: 'src/server/routers/blocks.router.ts',
      fn: 'getNavSummary: protectedProcedure',
      why: "the nav `hasActivity` probe over the viewer's own rows",
    },
  ] as const;

  it.each(VIEWER_OWN_READS)(
    '[INV] $fn is deliberately NOT filtered — in any spelling that exists today',
    ({ file, fn, why }) => {
      // 🔴 THE OVER-FILTERING HAZARD, PINNED. A moderator must keep seeing what they
      // themselves did; filtering here would delete the reviewer's own audit trail to solve
      // an owner-visibility problem. This fails if someone "completes" the filter by adding
      // it, which is the change that looks like a fix and is not.
      //
      // 🔴 A SPELLED GUARD IS WALKABLE BY RESPELLING, AND THIS ONE WAS — TWICE, WHICH IS WHY
      // THE LIST BELOW IS ENUMERATED RATHER THAN DESCRIBED. Round 1 counted only the
      // identifier `OWNER_VISIBLE_INVOCATION_FILTER`, so a mutant adding the literal
      // `source: { not: 'private-run' }` to the nav probe survived the whole suite. The
      // round-1 fix then claimed to catch the marker "in any spelling" over three text
      // checks, and a round-2 audit walked THAT: a top-level Prisma `NOT:` naming the
      // imported constant contains none of those three strings.
      //
      // ⚠️ SO THIS IS AN ENUMERATION, NOT A UNIVERSAL. It forbids every form that exists in
      // this codebase today and CANNOT see a form nobody has written. Saying which is the
      // point; a guard claiming universality over a grep list is what stops the next reader
      // checking.
      const source = read(file);
      const at = source.indexOf(fn);
      expect(at, `${fn} must still exist under this name`).toBeGreaterThan(0);
      const after = source.slice(at + fn.length);
      const nextDecl = after.search(
        /\n(?:export )?(?:async )?function |\n(?:export )?type |\n(?:export )?const |\n  \w+: (?:protected|moderator|public)/
      );
      const body = nextDecl === -1 ? after : after.slice(0, nextDecl);

      // Positive control: the region really is a read of THIS table, not an empty or wrong
      // slice — without it every `not.toContain` below is vacuously true.
      expect(body, `${fn} must still read the invocations table`).toContain(
        'blockScopeInvocation.'
      );
      // And it really is self-scoped, which is the premise of the whole case.
      expect(body, `${fn} must still be keyed on the viewer's own userId`).toContain('userId');

      for (const [form, needle] of [
        ['the shared owner filter', 'OWNER_VISIBLE_INVOCATION_FILTER'],
        ['the marker constant by name', 'PRIVATE_RUN_INVOCATION_SOURCE'],
        ['the marker as a literal', "'private-run'"],
        ['a `source:` object literal', 'source: {'],
        ['a top-level Prisma NOT on the column', 'NOT: { source'],
        ['a raw SQL predicate on the column', '"source"'],
      ] as const) {
        expect(
          body,
          `${fn} (${why}) must not exclude the marker via ${form} — a private run is the ` +
            "reviewer's OWN activity here, and hiding it deletes their audit trail"
        ).not.toContain(needle);
      }
    }
  );
});
