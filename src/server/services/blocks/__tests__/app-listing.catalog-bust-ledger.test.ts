import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { stripCommentsAndStrings } from '../../../../../test/strip-comments';

/**
 * 🔴 `/apps` CATALOG FRESHNESS LEDGER — every `AppListing` WRITER either busts the
 * catalog cache or is on an explicit `EXEMPT` list with a reason.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The `/apps` catalog is served from a 180s `queryCache` entry (#529). That cache has
 * two halves, and only one of them had coverage:
 *
 *   · CORRECTNESS OF THE KEY — that two viewer classes can never share an entry.
 *     Guarded by `app-listing.catalog-cache.test.ts`.
 *   · FRESHNESS — that every mutation which changes catalog membership or a cached
 *     axis deletes the entry. Guarded by NOTHING, until this file.
 *
 * That gap is not hypothetical, and it is not the kind a behavioural test finds either.
 * It shipped in the very change that introduced the cache: `approveExternalRequest`
 * `return`s into `applyApprovedRevision` for every approval of an edit to an
 * already-live listing, BEFORE reaching its own bust, and `applyApprovedRevision` had
 * none. The offsite branch there writes `contentRating` (the maturity gate),
 * `category` (a cached filter) and `name` (the `sort='name'` sort key) straight onto
 * the LIVE parent. A `g`→`r` re-rating sat in the cached SFW page for the full TTL.
 *
 * A per-mutation behavioural test would not have caught it: nobody writes a test for
 * the function they forgot.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY IT ENUMERATES WRITERS AND NOT BUSTERS
 * ─────────────────────────────────────────────────────────────────────────────
 * The first version of this file pinned only the SET OF BUST CALL SITES, and its
 * header claimed that went red "when a new listing mutation appears without a bust".
 * IT DID NOT, and that is the exact defect above: a mutation with no bust adds no call
 * site, so the pinned set is unchanged and the ledger stays green. Measured on this
 * branch — appending an `export async function forgetfulDelist()` that flips an
 * approved row to `removed` with no bust left the bust-only ledger at 5 passed /
 * 0 failed. A guard that reads as coverage while providing none is worse than no
 * guard, because it stops anyone looking.
 *
 * So the primary assertion is INVERTED. The scan enumerates every writer of the
 * `AppListing` table (`<client>.appListing.{create,createMany,update,updateMany,
 * upsert,delete,deleteMany}`, including `tx.` forms inside a transaction), resolves
 * each to its enclosing function, and requires that function to be EITHER a bust call
 * site OR on `EXEMPT` with a one-line reason. A new un-busted mutation then fails by
 * construction.
 *
 * The bust set is STILL pinned as `LEDGER`, for the other direction: deleting a bust
 * removes a call site, which the writer scan alone cannot see.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES AND DOES NOT CLAIM
 * ─────────────────────────────────────────────────────────────────────────────
 * Both halves are STRUCTURAL, and a structural check type-checks straight past a
 * buster that passes the wrong tag — so the behavioural half lives in
 * `app-listing.catalog-cache.test.ts` ("the buster busts the CATALOG tag"), and the
 * behavioural regression test for the revision path lives in
 * `offsite-listing.onsite-revision.service.test.ts`.
 *
 * It also does NOT claim every `LEDGER` entry is load-bearing. Several busts are
 * deliberately INERT today (a bust on a `draft`/`pending`/`removed` row the
 * approved-only query already excludes); each such site says so at the call site. What
 * the ledger pins is that adding or removing one is a DECISION someone made on purpose.
 *
 * It sees only what a lexical scan can see: a write issued through a Prisma delegate
 * named `appListing`. A raw `$executeRaw` UPDATE against `app_listings`, or a write
 * behind a dynamically-named delegate, is invisible to it. No claim is made about those.
 *
 * 🔴 AND TWO CACHED AXES DO NOT LIVE ON THIS TABLE AT ALL, so the scan can enumerate NO
 * writers for them — a stronger blind spot than the one above, because the writers are
 * ordinary, present, and busting nothing:
 *   · the `app_listing_metrics` ROLLUP that feeds `sort='top-rated'` and `sort='popular'`.
 *     `app-listing-review.service.ts::applyRecommendMetricDelta` writes
 *     `thumbsUp/DownCount` on every review vote and busts only the recommend-MEAN tag;
 *     `~/server/metrics/appListing.metrics.sql.ts` raw-upserts `install_count` — the
 *     whole `sort='popular'` key and the `top-rated` tiebreak — on the metric job, and
 *     busts nothing. (`open_count`, upserted alongside it, is NOT a cached axis: no
 *     `sort_key` reads it.)
 *   · nothing else — `ab.current_version_deployed_at` lives on `app_blocks`, but its one
 *     writer IS covered, via `build-callback.ts::watchApplyJobAndRecord` in `LEDGER`.
 * Both metric behaviours are DELIBERATE and are the right trade: busting the catalog on
 * every review vote or metric-job pass would defeat the cache outright, and the cost is
 * bounded at `CacheTTL.sm` of SORT lag — no row appears, disappears, or changes maturity.
 * That is a decision, not a gap; but it means the "reads exactly … and NOTHING else" rule
 * stated below is violated BY DESIGN on those two, and a reader applying the rule to a
 * metrics writer would reach the wrong conclusion.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHEN THIS GOES RED
 * ─────────────────────────────────────────────────────────────────────────────
 * · You added an `AppListing` mutation → either call `bustAppListingCatalogCache()`
 *   from it and add its `<file>::<fn>` to `LEDGER`, or add it to `EXEMPT` with a
 *   one-line reason clearing one of the two bars stated there.
 * · You removed a bust → prove the mutation cannot change catalog membership or a
 *   CACHED axis (`al.status`, `al.kind`, `al.category`, `al.content_rating`,
 *   `al.revision_of_id`, `al.app_block_id`, `ab.current_version_deployed_at`, or the
 *   `sort_key` inputs `al.name` / `al.created_at` / the metric rollup) — remembering
 *   that every PROJECTION field on the card is hydrated live and can never be stale —
 *   then move the row from `LEDGER` to `EXEMPT` in the same commit.
 * · You added a caller to an `EXEMPT` bar-2 helper → see `CALLER_BUSTS`. That caller
 *   need not write the table itself, which is exactly why prose could not hold it.
 * · You RENAMED the buster → the scan finds zero and the positive control below fires
 *   first, naming the instrument rather than the code.
 * · A site reports `<unattributed>` → the parser could not name its enclosing
 *   function. That is a defect in THIS FILE, not in the code under scan; fix
 *   `classifyBrace` rather than working around it.
 * · A file fails the BRACE-BALANCE check → `stripCommentsAndStrings` left an unmatched
 *   `{` or `}` behind (a regex literal is the known shape), so `buildFrames` would
 *   mis-nest and attribute a write to the wrong real function. See `buildFrames`.
 */

const ROOT = process.cwd();

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    // Dot-dirs cover `.git`, `.next`, `.turbo` in one rule.
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

/** Every repo root that could hold a caller. `src` is where they all are today. */
const ROOTS = ['src', 'apps', 'packages', 'scripts'];

const FILES = ROOTS.flatMap((r) => walk(join(ROOT, r)))
  .map((f) => relative(ROOT, f).split(sep).join('/'))
  // Tests are excluded: a spec asserting ON the buster is not a production caller, and
  // counting one would let a deleted production bust be masked by its own test.
  .filter((f) => !/(^|\/)(__tests__|__mocks__|tests?)\/|\.(test|spec)\.tsx?$/.test(f));

/**
 * A CALL, not a mention. Three separate exclusions, and they are NOT interchangeable —
 * an earlier version of this comment credited `\(` with all of them, which is wrong in a
 * way that invites deleting the one that matters:
 *   · PROSE — removed by `stripCommentsAndStrings` (this codebase discusses the buster
 *     at length in comments);
 *   · the `import { … }` line — excluded by `\(`, since a specifier is not an invocation;
 *   · the `export async function bustAppListingCatalogCache(…)` DECLARATION — NOT
 *     excluded by `\(`, because a declaration's own parameter list matches `name\s*\(`
 *     exactly like a call. The `\bfunction\s+$` lookback in `scan` is what drops it, as
 *     that line's own comment says.
 */
const CALL_RE = /\bbustAppListingCatalogCache\s*\(/g;

/**
 * A WRITE to the `AppListing` table through any Prisma client handle — `dbWrite.`,
 * `tx.`, `client.`, whatever the local binding is called. `\.\s*appListing\s*\.`
 * cannot match the sibling delegates (`appListingReport`, `appListingScreenshot`,
 * `appListingPublishRequest`, `appListingModerationEvent`): those need a word
 * character where this requires a `.`.
 */
const WRITE_RE =
  /\.\s*appListing\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;

// ---------------------------------------------------------------------------
// ENCLOSING-FUNCTION ATTRIBUTION
// ---------------------------------------------------------------------------
/**
 * 🔴 THIS IS A BACKWARD PARSE, NOT A PATTERN LIST — because THREE earlier pattern
 * versions each mis-attributed silently, in a different shape, and a silent wrong name
 * is the worst output this file can produce (it sends the reader to a function that had
 * nothing to do with the site).
 *
 * The shapes that already bit us:
 *   · a two-space-indented `name(` alternative added to name class methods also matched
 *     `  if (` and `  switch (`, so four real mutations were attributed to a function
 *     called `if`;
 *   · dropping that alternative and anchoring at column 0 made class methods invisible
 *     instead: re-adding the bust inside `BlockRegistry.setMarketplaceMeta` reported it
 *     as `block-registry.service.ts::resolveRenderMode`, a top-level helper that is not
 *     even nearby in that file — while a comment at that call site instructs a future
 *     maintainer to add exactly that function to this ledger;
 *   · a leftmost-match regex over a lookback window jumped to the PREVIOUS function
 *     whenever the signature contained an object-type parameter (`function f(opts: {`),
 *     so `delistListing` was reported as `flipBackingBlockStatus`.
 *
 * So instead of guessing at the text, `classifyBrace` walks BACKWARD from each `{` with
 * real bracket matching and decides what that brace opens. Frames are then nested by
 * brace depth, and a site is attributed to the OUTERMOST enclosing function frame (so a
 * `$transaction(async (tx) => { … })` callback still reports its owning service
 * function), qualified by an enclosing class as `Class::method`.
 *
 * When it cannot name a frame it says `<unattributed>` and a test below FAILS on that,
 * naming the file. Failing loudly is deliberate: a fourth mis-attribution shape is more
 * likely than not, and the cost of a wrong name is higher than the cost of a red build.
 */
const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'with', 'typeof',
  'await', 'yield', 'new', 'delete', 'void', 'in', 'of', 'case', 'function', 'class',
  'super', 'this', 'throw', 'try', 'finally', 'import', 'export', 'const', 'let', 'var',
  'default', 'static', 'async', 'get', 'set',
]); // prettier-ignore

const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isIdent = (c: string) => /[\w$]/.test(c);

const skipWsBack = (code: string, j: number) => {
  while (j >= 0 && isWs(code[j])) j--;
  return j;
};

/** `code[j]` is `close`; return the index of its matching `open`, or -1. */
const matchBack = (code: string, j: number, open: string, close: string) => {
  let depth = 0;
  while (j >= 0) {
    if (code[j] === close) depth++;
    else if (code[j] === open) {
      depth--;
      if (depth === 0) return j;
    }
    j--;
  }
  return -1;
};

/** Consume the identifier ending at `j`; returns it plus the index before it. */
const identBack = (code: string, j: number) => {
  const end = j + 1;
  while (j >= 0 && isIdent(code[j])) j--;
  return { name: code.slice(j + 1, end), before: j };
};

/**
 * Step backward over a return-type annotation (`: Promise<{ id: string }>`) and return
 * the index of its leading `:`, or -1. Object types are matched as brackets, which is
 * what a character-class scan could not do — that omission is what left `acceptTransfer`
 * and `updateRevisionDraft` unattributed.
 *
 * 🔴 BOUNDED, because the `}` case makes this a bracket walk and an unbounded bracket
 * walk RUNS AWAY: starting at the `}` that ends the previous function it hops the whole
 * body and keeps going, eventually finding some unrelated `:` and reporting a type
 * annotation that is not there. `MAX_TYPE_SPAN` caps the travel; a real annotation is
 * far shorter, and exceeding it means the answer would have been a guess.
 */
const MAX_TYPE_SPAN = 400;
const typeAnnotationStart = (code: string, from: number) => {
  let j = from;
  while (j >= 0 && from - j <= MAX_TYPE_SPAN) {
    j = skipWsBack(code, j);
    if (j < 0) return -1;
    const c = code[j];
    if (c === '}') j = matchBack(code, j, '{', '}') - 1;
    else if (c === ']') j = matchBack(code, j, '[', ']') - 1;
    else if (c === '>') j = matchBack(code, j, '<', '>') - 1;
    else if (isIdent(c) || c === '.' || c === '|' || c === '&' || c === '?' || c === ',') j--;
    else return c === ':' ? j : -1;
  }
  return -1;
};

type Frame = {
  start: number;
  end: number;
  kind: 'fn' | 'class' | 'method' | 'block';
  name: string;
};

/** What does the `{` at `braceIdx` open? */
const classifyBrace = (code: string, braceIdx: number): Omit<Frame, 'start' | 'end'> | null => {
  let j = skipWsBack(code, braceIdx - 1);
  if (j < 0) return null;

  // `class X … {`. FIRST, because its regex is anchored hard against the brace and so
  // cannot false-positive, whereas the bracket walk below would step back over the `}`
  // that closes the preceding function and mis-read what it found there.
  const head = code.slice(Math.max(0, braceIdx - 300), braceIdx);
  const cls =
    /(?:^|[\s;{}])(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+(?:extends|implements)\s+[\w$.,<>\s]*)?\s*$/.exec(
      head
    );
  if (cls) return { kind: 'class', name: cls[1] };

  // `… => {` — an arrow function. Named only when it is `const NAME = … => {`.
  if (code[j] === '>' && code[j - 1] === '=') {
    j = skipWsBack(code, j - 2);
    const annotated = code[j] === ')' ? j : -1;
    if (annotated >= 0) j = skipWsBack(code, matchBack(code, annotated, '(', ')') - 1);
    else {
      const param = identBack(code, j);
      if (!param.name) return null;
      j = skipWsBack(code, param.before);
    }
    const maybeAsync = identBack(code, j);
    if (maybeAsync.name === 'async') j = skipWsBack(code, maybeAsync.before);
    if (code[j] !== '=') return null; // an anonymous callback — no name to give it
    j = skipWsBack(code, j - 1);
    const colon = typeAnnotationStart(code, j);
    if (colon >= 0) j = skipWsBack(code, colon - 1);
    const named = identBack(code, j);
    if (!named.name || RESERVED.has(named.name)) return null;
    return { kind: 'fn', name: named.name };
  }

  // `… ( … ) [: T] {` — a function declaration, a class method, or `if`/`for`/`switch`.
  let close = -1;
  if (code[j] === ')') close = j;
  else {
    const colon = typeAnnotationStart(code, j);
    if (colon >= 0) {
      const p = skipWsBack(code, colon - 1);
      if (code[p] === ')') close = p;
    }
  }
  if (close >= 0) {
    const open = matchBack(code, close, '(', ')');
    if (open < 0) return null;
    let p = skipWsBack(code, open - 1);
    if (code[p] === '>') {
      const lt = matchBack(code, p, '<', '>');
      if (lt < 0) return null;
      p = skipWsBack(code, lt - 1);
    }
    const named = identBack(code, p);
    if (!named.name) return null;
    const pre = code.slice(Math.max(0, named.before - 60), named.before + 1);
    if (/\bfunction\s*\*?\s*$/.test(pre)) return { kind: 'fn', name: named.name };
    // `if (…) {`, `for (…) {`, `catch (…) {`, and any bare call are excluded here.
    if (RESERVED.has(named.name)) return null;
    // A class-method header carries only member modifiers (or nothing) before the name.
    if (
      /(?:^|[\s;{}])(?:(?:public|private|protected|static|async|readonly|abstract|override|get|set)\s+)*$/.test(
        pre
      )
    )
      return { kind: 'method', name: named.name };
    return null;
  }

  return null;
};

type Walk = {
  frames: Frame[];
  /** `#{` − `#}` over the whole file. Non-zero ⇒ the frames below are mis-nested. */
  braceDelta: number;
  /** The lowest depth the walk reached. Negative ⇒ a `}` arrived with no open frame. */
  minDepth: number;
};

/**
 * 🔴 THE FRAMES ARE ONLY AS GOOD AS THE STRIPPER, AND THE STRIPPER DOES NOT KNOW ABOUT
 * REGEX LITERALS. `stripCommentsAndStrings` removes comments, template literals and
 * quoted strings; a `{` or `}` inside a REGEX literal — `/^\s*\{/` — survives. One stray
 * brace re-nests every frame after it, and the failure is SILENT AND WORSE THAN A CRASH:
 * a write is not reported as `<unattributed>`, it is attributed to a DIFFERENT REAL
 * FUNCTION, which then reads as covered because that function is in `LEDGER`/`EXEMPT`.
 *
 * Measured on this branch: inserting `const _jsonHead = /^\s*\{/;` into `acceptTransfer`
 * (`app-ownership-transfer.service.ts`, a file with no bust sites, so the `LEDGER`
 * equality pin cannot see the collapse) and appending an un-busting `forgetfulDelist()`
 * that flips an approved row to `removed` left the ledger at 8 passed / 0 failed — the
 * new writer folded into `acceptTransfer`, which is `EXEMPT`. That is exactly the writer
 * this file exists to catch. The same mutant with a BALANCED regex fails correctly, so
 * the brace is the variable, not the mutation.
 *
 * 🔴 SO THE WALK REPORTS ITS OWN BALANCE AND A TEST BELOW FAILS ON IT. That is the fix
 * rather than teaching the stripper about regex literals, because a balance check cannot
 * be walked by a shape nobody thought of: any construct that leaks an unmatched brace —
 * regex literal or otherwise — is caught, whereas a regex-literal stripper only closes
 * the one shape we happen to have seen (and `/` is genuinely ambiguous with division, so
 * it would be a heuristic in a module two OTHER guards also depend on). 39 of the 5,123
 * files in the tree do not balance after stripping; none contributes a site today, and
 * each becomes a red build the day it gains one.
 */
const buildFrames = (code: string): Walk => {
  const frames: Frame[] = [];
  const stack: Frame[] = [];
  let depth = 0;
  let minDepth = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') {
      depth++;
      const hit = classifyBrace(code, i);
      const frame: Frame = {
        start: i,
        end: code.length,
        kind: hit?.kind ?? 'block',
        name: hit?.name ?? '',
      };
      // A method-shaped header is a function only when a class actually encloses it;
      // otherwise it is an object-literal shorthand and must not shadow the real owner.
      if (frame.kind === 'method')
        frame.kind = stack.some((f) => f.kind === 'class') ? 'fn' : 'block';
      stack.push(frame);
      frames.push(frame);
    } else if (code[i] === '}') {
      depth--;
      if (depth < minDepth) minDepth = depth;
      const frame = stack.pop();
      if (frame) frame.end = i;
    }
  }
  return { frames, braceDelta: depth, minDepth };
};

/** Does this file's stripped text brace-balance? `minDepth` catches a `+1/−1` that cancels. */
const braceImbalance = (walk: Walk): string | null =>
  walk.braceDelta === 0 && walk.minDepth === 0
    ? null
    : `delta ${walk.braceDelta > 0 ? '+' : ''}${walk.braceDelta}, min depth ${walk.minDepth}`;

/**
 * `<unattributed>` vs `<module scope>` — these are DIFFERENT verdicts and only one is a
 * defect, which is why the "every site resolves" test below filters for the first alone.
 *   · `<unattributed>` — the site IS inside braces and the parser could not name the
 *     frame. A parse failure; fix `classifyBrace`.
 *   · `<module scope>` — the site is inside no braces at all, i.e. a genuine top-level
 *     write. That is a correct answer, not a parse failure, and it needs no guard of its
 *     own: `<file>::<module scope>` can never be in `LEDGER` (a top-level statement
 *     cannot call the buster meaningfully) and would have to be typed by hand into
 *     `EXEMPT`, so the headline coverage guard reports it, loudly and by name.
 */
const attribute = (frames: Frame[], index: number): string => {
  const enclosing = frames
    .filter((f) => f.start < index && index < f.end)
    .sort((a, b) => a.start - b.start);
  const fns = enclosing.filter((f) => f.kind === 'fn');
  if (!fns.length) return enclosing.length ? '<unattributed>' : '<module scope>';
  const outer = fns[0];
  const cls = enclosing.filter((f) => f.kind === 'class' && f.start < outer.start).pop();
  return cls ? `${cls.name}::${outer.name}` : outer.name;
};

/** A CALL to `name`, excluding its own declaration — the `CALL_RE` rule, generalised. */
const callsOf = (code: string, name: string) =>
  [...code.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].filter(
    (m) => !/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 40), m.index))
  );

/**
 * `{ busts, writes, helperCallers, imbalanced }` — the first three as sorted,
 * de-duplicated `<file>::<fn>` sets, `imbalanced` as `<file> (…)` strings.
 */
const scan = (files: string[], helpers: string[]) => {
  const busts: string[] = [];
  const writes: string[] = [];
  const helperCallers: Record<string, string[]> = Object.fromEntries(helpers.map((h) => [h, []]));
  const imbalanced: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    // Cheap pre-filter: skip the ~99% of files that mention none of them.
    if (
      !source.includes('bustAppListingCatalogCache') &&
      !source.includes('appListing.') &&
      !helpers.some((h) => source.includes(h))
    )
      continue;
    const code = stripCommentsAndStrings(source);
    CALL_RE.lastIndex = 0;
    WRITE_RE.lastIndex = 0;
    const bustHits = [...code.matchAll(CALL_RE)].filter(
      // 🔴 The buster's own DECLARATION in `app-listing.service` matches `name\s*\(` too.
      (m) => !/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 40), m.index))
    );
    const writeHits = [...code.matchAll(WRITE_RE)];
    const helperHits = helpers.map((h) => [h, callsOf(code, h)] as const);
    if (!bustHits.length && !writeHits.length && !helperHits.some(([, hits]) => hits.length))
      continue;
    const walk = buildFrames(code);
    // Recorded, NOT skipped: attribution still runs, so exactly one test goes red and it
    // is the one that names the real cause. Skipping would empty this file's sets and
    // fire the LEDGER-equality guard too, for the same single finding.
    const imbalance = braceImbalance(walk);
    if (imbalance) imbalanced.push(`${file} (${imbalance})`);
    const { frames } = walk;
    for (const m of bustHits) busts.push(`${file}::${attribute(frames, m.index)}`);
    for (const m of writeHits) writes.push(`${file}::${attribute(frames, m.index)}`);
    for (const [h, hits] of helperHits)
      for (const m of hits) helperCallers[h].push(`${file}::${attribute(frames, m.index)}`);
  }
  return {
    busts: [...new Set(busts)].sort(),
    writes: [...new Set(writes)].sort(),
    helperCallers: Object.fromEntries(
      Object.entries(helperCallers).map(([h, c]) => [h, [...new Set(c)].sort()])
    ) as Record<string, string[]>,
    imbalanced: imbalanced.sort(),
  };
};

/**
 * 🔴 THE BUST LEDGER. `<file>::<enclosing function>`, sorted.
 *
 * Deduplicated on purpose: `updateListing` calls the buster from four of its status
 * branches, and a fifth branch would be a code review question, not a ledger change.
 * What the ledger pins is WHICH MUTATIONS bust, not how many `await`s each contains.
 */
const LEDGER = [
  // The ONE non-tRPC writer of `current_version_deployed_at` — the onsite deploy gate
  // in the cached statement. Without it a freshly-deployed app is simply absent.
  'src/pages/api/internal/blocks/build-callback.ts::watchApplyJobAndRecord',
  // Mints rows at `status:'approved'` — a go-live path, not a data migration.
  'src/server/services/blocks/app-listing-backfill.service.ts::backfillAppListings',
  // All three run `reDeriveContentRatingForModLiveEdit` inside their tx, which can RAISE
  // `content_rating` — the `listingMatureFilter` axis.
  'src/server/services/blocks/app-listing-assets.service.ts::addListingScreenshot',
  'src/server/services/blocks/app-listing-assets.service.ts::setListingCover',
  'src/server/services/blocks/app-listing-assets.service.ts::setListingIcon',
  // Catalog membership + the live-parent scalar writes.
  'src/server/services/blocks/offsite-listing.service.ts::applyApprovedRevision',
  'src/server/services/blocks/offsite-listing.service.ts::approveExternalRequest',
  'src/server/services/blocks/offsite-listing.service.ts::rejectExternalRequest',
  'src/server/services/blocks/offsite-listing.service.ts::submitListingRevision',
  'src/server/services/blocks/offsite-listing.service.ts::updateListing',
  // Moderator + owner state transitions — every one of these is catalog membership.
  'src/server/services/blocks/offsite-moderation.service.ts::claimListing',
  'src/server/services/blocks/offsite-moderation.service.ts::delistListing',
  'src/server/services/blocks/offsite-moderation.service.ts::purgeListing',
  'src/server/services/blocks/offsite-moderation.service.ts::relistListing',
  'src/server/services/blocks/offsite-moderation.service.ts::republishOwnListing',
  'src/server/services/blocks/offsite-moderation.service.ts::resetListingToPending',
  'src/server/services/blocks/offsite-moderation.service.ts::resetOnsiteListingToPending',
  'src/server/services/blocks/offsite-moderation.service.ts::unpublishOwnListing',
  // Onsite approve mints/flips the AppListing to `approved`.
  'src/server/services/blocks/publish-request.service.ts::approveRequest',
].sort();

/**
 * 🔴 `AppListing` WRITERS THAT DELIBERATELY DO NOT BUST, each with the reason.
 *
 * 🔴 THERE ARE TWO BARS, NOT ONE, AND A ROW MUST SAY WHICH IT CLEARS. An earlier version
 * of this preamble stated only the first ("the write provably cannot move a CACHED
 * axis") while the list already granted the second — so one row was exempt on an
 * argument the stated bar does not admit, and a reader checking the list against the
 * rule would have found a contradiction rather than the real reasoning:
 *
 *   1. CANNOT-MOVE — the write provably cannot move a cached axis. Every row below
 *      except one clears this bar, and it is the bar to prefer.
 *   2. CALLER-BUSTS — the write DOES move a cached axis, but it is an in-tx helper and
 *      every one of its callers busts after the commit. This is strictly weaker: it
 *      rests on a claim about the CALLER SET, which prose cannot hold and a reader
 *      cannot check. A row claiming it MUST also appear in `CALLER_BUSTS` below, which
 *      pins the caller set mechanically. Today exactly one row does
 *      (`reDeriveContentRatingForModLiveEdit`). `routeRepublishToReviewInTx` also cites
 *      its caller, but it independently clears bar 1 — its `where` selects
 *      `status:'removed'`, so the row it moves is not a catalog member either way — so
 *      it needs no pin.
 *
 * The cached statement reads exactly: `al.id`, `al.status`, `al.revision_of_id`,
 * `al.kind`, `al.category`, `al.content_rating` (via `listingMatureFilter`),
 * `al.app_block_id` (the join key onto `app_blocks` for the deploy gate),
 * `ab.current_version_deployed_at`, and the `sort_key` inputs (`al.name`,
 * `al.created_at`, the `app_listing_metrics` rollup). It reads NOTHING else — every
 * other column on the card is hydrated live below the cache and can never be served
 * stale. ⚠️ Two of those axes are not on this table and this scan cannot see their
 * writers; the header's blind-spot section says which, and why that is deliberate.
 *
 * Each reason below was re-derived against the code at this commit, not inherited.
 */
const EXEMPT: Record<string, string> = {
  'src/server/services/blocks/app-listing-assets.service.ts::backfillListingAssets':
    'writes only `coverId` / `iconId`, both hydrated projection fields — no cached axis.',
  'src/server/services/blocks/app-listing-assets.service.ts::reDeriveContentRatingForModLiveEdit':
    'BAR 2 (CALLER-BUSTS), the only row here that is: it DOES raise `content_rating`. ' +
    'Every caller busts post-commit — a bust inside the tx would also fire on a ' +
    'rollback — and the caller set is pinned in `CALLER_BUSTS`, not asserted here in ' +
    'prose, because a fourth caller is invisible to the writer scan (it issues no ' +
    '`appListing.` write of its own).',
  'src/server/services/blocks/app-ownership-transfer.service.ts::acceptTransfer':
    'writes only `userId`; the cached statement never reads ownership and no sort or ' +
    'filter keys on it (same argument `claimListing` makes for its own inert bust).',
  'src/server/services/blocks/offsite-listing.service.ts::beginListingRevision':
    "mints a shadow at `status:'draft'` with `revisionOfId` set — excluded twice over by " +
    'the approved-only and `revision_of_id IS NULL` filters.',
  'src/server/services/blocks/offsite-listing.service.ts::closeTerminalListing':
    'deletes a `draft` row or flips `pending`→`removed`; neither status is `approved`, so ' +
    'catalog membership is unchanged.',
  'src/server/services/blocks/offsite-listing.service.ts::submitExternalListing':
    "mints at `status:'draft'` — outside the approved-only query until an approve path " +
    '(which busts) promotes it.',
  'src/server/services/blocks/offsite-listing.service.ts::updateRevisionDraft':
    'writes the draft shadow, plus the beta half onto the live parent. `is_beta` is not ' +
    'in the cached statement and renders from the live per-page beta read.',
  'src/server/services/blocks/offsite-moderation.service.ts::routeRepublishToReviewInTx':
    'flips `removed`→`pending` (and floors `content_rating` on a non-approved row); its ' +
    'only caller, `republishOwnListing`, busts anyway.',
  'src/server/services/blocks/publish-request.service.ts::closeOnsiteResetListingOnWithdraw':
    'flips `pending`→`removed` — neither status is in the catalog.',
  'src/server/services/blocks/publish-request.service.ts::deleteOnsiteDraftListingForSlug':
    "hard-deletes ONLY `{ kind:'onsite', appBlockId:null, status:'draft' }`; the narrowness " +
    'is load-bearing for authorization (civitai#3984) and keeps it off the catalog.',
  'src/server/services/blocks/publish-request.service.ts::submitVersion':
    "mints the pre-approval onsite listing at `status:'draft'`; `approveRequest` is the " +
    'path that promotes it, and it busts.',
};

/**
 * 🔴 THE CALLER SETS THAT BAR 2 OF `EXEMPT` RESTS ON.
 *
 * A helper listed here moves a cached axis and is exempt only because every caller busts
 * after the commit. Nothing in the writer scan can see that: the dangerous new caller is
 * one that runs the helper inside its own `dbWrite.$transaction` and issues NO
 * `appListing.` write of its own, so it never enters `WRITERS` and no guard in this file
 * mentions it.
 *
 * Measured on this branch: a fourth caller of exactly that shape, with no bust, left the
 * ledger at 8 passed / 0 failed and the function absent from `WRITERS` entirely. If it
 * landed, a moderator raising an approved listing `g`→`r` would sit in the cached SFW
 * page for the full `CacheTTL.sm` — verbatim the narrative in this file's own header.
 *
 * So the set is pinned: every caller must be a `LEDGER` bust site, AND the set must be
 * exactly what is recorded. The second half is bookkeeping, not safety — a fourth
 * BUSTING caller is fine and its red is "record the decision", the same contract the
 * `LEDGER` set assertion states for a new bust.
 */
const CALLER_BUSTS: Record<string, string[]> = {
  reDeriveContentRatingForModLiveEdit: [
    'src/server/services/blocks/app-listing-assets.service.ts::addListingScreenshot',
    'src/server/services/blocks/app-listing-assets.service.ts::setListingCover',
    'src/server/services/blocks/app-listing-assets.service.ts::setListingIcon',
  ].sort(),
};

describe('🔴 /apps catalog freshness ledger', () => {
  const {
    busts: SITES,
    writes: WRITERS,
    helperCallers: HELPER_CALLERS,
    imbalanced: IMBALANCED,
  } = scan(FILES, Object.keys(CALLER_BUSTS));

  /**
   * 🔴 INSTRUMENT FIRST. Every assertion below is a set comparison, and a scan wired to
   * nothing produces an EMPTY set — which reads as "the ledger shrank", i.e. a confident
   * finding about the code that is really a fact about the walk. Prove the walk found a
   * real population and both regexes can match before reading any verdict.
   */
  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain('src/server/services/blocks/offsite-listing.service.ts');
    expect(SITES.length).toBeGreaterThan(10);
    expect(WRITERS.length).toBeGreaterThan(15);
    for (const root of ROOTS) {
      expect(FILES.some((f) => f.startsWith(`${root}/`))).toBe(true);
    }
  });

  /**
   * 🔴 POSITIVE CONTROL ON THE REGEXES + STRIPPER + ATTRIBUTOR, through the same code
   * path the file scan uses. Every shape here is one the real tree contains, and the
   * last three are the three mis-attributions this parser replaced: a call nested inside
   * `if`/`switch`, a class method, and a signature whose parameter is an object type.
   */
  it('POSITIVE CONTROL: the matcher matches calls, and only calls, and names them right', () => {
    const sample = [
      "import { bustAppListingCatalogCache } from '~/server/services/blocks/app-listing.service';",
      '// A comment naming bustAppListingCatalogCache() must not count.',
      // The DECLARATION must not count either — and note the helper before it, which is
      // exactly what a backward scan reports if the declaration slips through.
      'function neighbouringHelper() { return 1; }',
      'export async function bustAppListingCatalogCache(): Promise<void> {}',
      'export async function realCaller() {',
      '  if (cond) {',
      '    switch (x) {',
      '      default:',
      '        await bustAppListingCatalogCache().catch(() => undefined);',
      '    }',
      '  }',
      '}',
      'export async function secondCaller() {',
      '  await dbWrite.$transaction(async (tx) => {',
      '    await tx.appListing.updateMany({ where: {}, data: {} });',
      '  });',
      '}',
      'export async function objectParamCaller(opts: {',
      '  id: string;',
      '}): Promise<{ ok: boolean }> {',
      '  await dbWrite.appListing.update({ where: {}, data: {} });',
      '  return { ok: true };',
      '}',
      'export class Registry {',
      '  static async setMarketplaceMeta(input: { id: string }): Promise<void> {',
      '    await bustAppListingCatalogCache();',
      '  }',
      '}',
      // Sibling delegates must NOT be read as AppListing writes.
      'export async function notAWriter() {',
      '  await dbWrite.appListingReport.updateMany({ where: {}, data: {} });',
      '  await dbWrite.appListingScreenshot.create({ data: {} });',
      '}',
    ].join('\n');
    const code = stripCommentsAndStrings(sample);
    const { frames } = buildFrames(code);
    const bustHits = [...code.matchAll(new RegExp(CALL_RE.source, 'g'))]
      .filter((m) => !/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 40), m.index)))
      .map((m) => attribute(frames, m.index));
    const writeHits = [...code.matchAll(new RegExp(WRITE_RE.source, 'g'))].map((m) =>
      attribute(frames, m.index)
    );
    expect(
      bustHits,
      'the matcher missed a real call shape, counted prose/an import/the declaration, ' +
        'attributed a call to an enclosing `if`/`switch`, or could not name a class method.'
    ).toEqual(['realCaller', 'Registry::setMarketplaceMeta']);
    expect(
      writeHits,
      'the write matcher missed a `tx.`/`dbWrite.` write, mis-attributed one across an ' +
        'object-type parameter, or matched a SIBLING delegate (appListingReport / ' +
        'appListingScreenshot) that is not the AppListing table.'
    ).toEqual(['secondCaller', 'objectParamCaller']);
  });

  /**
   * 🔴 NEGATIVE CONTROL. A ledger that cannot go red is decorative. Perturb each SET the
   * way a regression would and confirm the comparisons notice.
   */
  it('NEGATIVE CONTROL: both comparisons detect a shrink and a growth', () => {
    // The bust set: one entry removed (a deleted bust), one added (an unrecorded bust).
    expect(SITES.slice(1)).not.toEqual(LEDGER);
    expect([...SITES, 'src/server/services/blocks/new.service.ts::newMutation'].sort()).not.toEqual(
      LEDGER
    );
    // The coverage rule, run over a SYNTHETIC writer set so this control keeps testing
    // the comparison rather than re-testing the tree (the real verdict is the guard
    // below; duplicating it here would make both go red for one finding).
    const covered = (w: string) => SITES.includes(w) || w in EXEMPT;
    const synthetic = [SITES[0], Object.keys(EXEMPT)[0]];
    expect(synthetic.filter((w) => !covered(w))).toEqual([]);
    expect(
      [...synthetic, 'src/server/services/blocks/new.service.ts::forgetfulDelist'].filter(
        (w) => !covered(w)
      )
    ).toEqual(['src/server/services/blocks/new.service.ts::forgetfulDelist']);
  });

  /**
   * 🔴 CONTROL ON THE BRACE-BALANCE CHECK ITSELF, in both directions and on the EXACT
   * shape that walked the ledger. A balance check that cannot go red would be the same
   * decorative guard this file was rewritten to remove.
   */
  it('POSITIVE + NEGATIVE CONTROL: the brace walk sees an unmatched brace in a regex', () => {
    const withRegex = (re: string) =>
      buildFrames(
        stripCommentsAndStrings(
          ['export function f() {', `  const head = ${re};`, '  return head;', '}'].join('\n')
        )
      );
    // The stripper removes comments/strings/templates — NOT regex literals. A brace
    // inside one survives, and it is the leak this check exists for.
    const unbalanced = withRegex('/^\\s*\\{/');
    expect(
      braceImbalance(unbalanced),
      'the walk no longer notices an unmatched `{` left behind by a regex literal — ' +
        'either the stripper started removing regexes (then say so and delete this ' +
        'control) or the balance accounting is broken.'
    ).toBe('delta +1, min depth 0');
    // Same construct, balanced: the check must NOT fire, or it is noise that gets muted.
    expect(braceImbalance(withRegex('/^\\s*\\{\\}/'))).toBeNull();
    // A stray CLOSER followed by a stray OPENER cancels in the delta, so `minDepth` is
    // the half that catches it — a `+1/−1` pair mis-nests just as badly as a lone `+1`.
    expect(
      braceImbalance(buildFrames(stripCommentsAndStrings('const a = /\\}/;\nconst b = /\\{/;\n')))
    ).toBe('delta 0, min depth -1');
  });

  /**
   * 🔴 THE FRAMES ARE ONLY TRUSTWORTHY IF THE FILE BALANCES. An unmatched brace surviving
   * the stripper re-nests everything after it, and a write then reports a DIFFERENT REAL
   * FUNCTION — no `<unattributed>`, no error, and the coverage guard reads as satisfied
   * because the name it landed on is in `LEDGER`/`EXEMPT`. See `buildFrames`.
   */
  it('🔴 every scanned file brace-balances after stripping', () => {
    expect(
      IMBALANCED,
      'these files still hold an unmatched `{`/`}` after `stripCommentsAndStrings`, so ' +
        'their frames mis-nest and every attribution in them is unsound. The known ' +
        'shape is a brace inside a REGEX LITERAL, which the stripper does not remove. ' +
        'Fix the stripper (or the file), NOT this list — skipping the file would hide ' +
        'exactly the un-busted writer this ledger exists to catch.'
    ).toEqual([]);
  });

  /**
   * 🔴 FAIL LOUDLY RATHER THAN NAME THE WRONG FUNCTION. `<unattributed>` means the
   * backward parse hit a shape it does not model; every verdict below would then be
   * computed against a name that does not exist in the file.
   */
  it('every site resolves to a named enclosing function', () => {
    const unresolved = [...SITES, ...WRITERS].filter((s) => s.endsWith('::<unattributed>'));
    expect(
      unresolved,
      'the enclosing-function parser could not name these sites. That is a defect in ' +
        'this test file (see `classifyBrace`), not in the code under scan — do not ' +
        'work around it by editing the ledger.'
    ).toEqual([]);
  });

  /**
   * 🔴 THE HEADLINE GUARD, and the one the bust-only version of this file did NOT
   * provide. Every writer of the `AppListing` table must either bust or be exempt.
   */
  it('🔴 every AppListing writer either busts the catalog cache or is EXEMPT', () => {
    const unbusted = WRITERS.filter((w) => !SITES.includes(w) && !(w in EXEMPT));
    expect(
      unbusted,
      'these functions write the `AppListing` table and neither call ' +
        '`bustAppListingCatalogCache()` nor appear in `EXEMPT`. If the write can change ' +
        'catalog MEMBERSHIP (`status`, `kind`, `revision_of_id`, the onsite deploy gate) ' +
        'or a CACHED axis (`category`, `content_rating`, `name`/`created_at`/the metric ' +
        'rollup that feed `sort_key`), call the buster after the commit and add the row ' +
        'to `LEDGER`. If it provably cannot, add it to `EXEMPT` with the reason. Every ' +
        'other column on the card is hydrated live and can never be stale.'
    ).toEqual([]);
  });

  /**
   * 🔴 THE OTHER HALF OF THE COVERAGE RULE — the one the writer scan is BLIND to. See
   * `CALLER_BUSTS`: a `EXEMPT` bar-2 row is only sound while every caller busts, and a
   * new caller that writes nothing itself never appears in `WRITERS`.
   */
  it('🔴 every CALLER of an exempt-by-caller helper busts, and the caller set is pinned', () => {
    for (const [helper, recorded] of Object.entries(CALLER_BUSTS)) {
      const callers = HELPER_CALLERS[helper] ?? [];
      // Instrument first: a rename makes the scan find zero, which would pass both
      // assertions below vacuously if `recorded` were also emptied.
      expect(
        callers.length,
        `no call sites found for \`${helper}\`. Either it was renamed (rename it here ` +
          'too) or it is gone (delete its `EXEMPT` row and this entry).'
      ).toBeGreaterThan(0);
      expect(
        callers.filter((c) => !SITES.includes(c)),
        `these functions call \`${helper}\`, which RAISES a cached axis inside the ` +
          "caller's transaction, and do NOT call `bustAppListingCatalogCache()`. That " +
          'is the whole basis of its `EXEMPT` row. Bust after the commit and add the ' +
          'caller to `LEDGER` — a bust inside the tx would fire on a rollback too.'
      ).toEqual([]);
      expect(
        callers,
        `the caller set of \`${helper}\` changed. Every caller busts (asserted above), ` +
          'so this is bookkeeping: record the new one here in the same commit, exactly ' +
          'as `LEDGER` requires for a new bust site. Do not widen it without reading ' +
          'why the row is exempt.'
      ).toEqual(recorded);
    }
  });

  it('the set of catalog-bust call sites is EXACTLY the ledger', () => {
    const missing = LEDGER.filter((e) => !SITES.includes(e));
    const extra = SITES.filter((e) => !LEDGER.includes(e));
    expect(
      SITES,
      'the set of `bustAppListingCatalogCache()` call sites changed.\n' +
        `  REMOVED (a bust that was here and is gone): ${JSON.stringify(missing)}\n` +
        `  ADDED   (a bust nobody recorded):           ${JSON.stringify(extra)}\n` +
        'A REMOVAL means some listing mutation no longer invalidates the /apps catalog ' +
        'entry, so the store grid can serve a delisted / re-rated / re-categorised row ' +
        'for the whole CacheTTL.sm window. An ADDITION is fine — record it here in the ' +
        'same commit, with one line saying which CACHED axis it moves (or that it is a ' +
        'deliberately inert defence-in-depth site). See this file`s header.'
    ).toEqual(LEDGER);
  });

  /**
   * 🔴 KEEP `EXEMPT` FROM ROTTING. An entry naming a function that no longer writes the
   * table is dead prose that will be trusted by the next reader; an entry that ALSO
   * busts is a contradiction about which rule applies.
   */
  it('every EXEMPT entry is a current, non-busting writer', () => {
    expect(
      Object.keys(EXEMPT).filter((e) => !WRITERS.includes(e)),
      'EXEMPT names a function that no longer writes `AppListing`. Delete the row.'
    ).toEqual([]);
    expect(
      Object.keys(EXEMPT).filter((e) => SITES.includes(e)),
      'EXEMPT names a function that DOES bust. Move it to `LEDGER`.'
    ).toEqual([]);
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(
        reason.length,
        `EXEMPT["${key}"] needs a real reason, not a placeholder`
      ).toBeGreaterThan(40);
    }
    // The two lists are one mechanism: a `CALLER_BUSTS` pin exists to hold up a bar-2
    // `EXEMPT` row, so a pin with no row is dead weight nobody will maintain.
    expect(
      Object.keys(CALLER_BUSTS).filter(
        (h) => !Object.keys(EXEMPT).some((k) => k.endsWith(`::${h}`))
      ),
      '`CALLER_BUSTS` pins a helper that is not on `EXEMPT`. Either it now busts (drop ' +
        'the pin) or its row was deleted (drop the pin).'
    ).toEqual([]);
  });

  /**
   * 🔴 THE ENTRY THIS LEDGER WAS BUILT FOR, called out by name.
   *
   * `approveExternalRequest` returns into `applyApprovedRevision` before reaching its
   * own bust, for EVERY approval of an edit to an already-live listing. The set
   * assertion above covers it, but it covers it anonymously — this pins it so a future
   * "tidy the ledger" pass cannot drop the row without reading why it is there.
   */
  it('🔴 `applyApprovedRevision` is in the ledger (it is NOT covered by its caller)', () => {
    expect(
      SITES,
      '`applyApprovedRevision` does not bust. `approveExternalRequest` RETURNS into it ' +
        'for every listing with `revisionOfId != null`, i.e. every approval of an edit ' +
        'to an already-live listing, BEFORE reaching its own bust. Its offsite branch ' +
        'writes contentRating (the maturity gate), category (a cached filter) and name ' +
        '(the sort key) onto the LIVE parent.'
    ).toContain('src/server/services/blocks/offsite-listing.service.ts::applyApprovedRevision');
  });
});
