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
 * ─────────────────────────────────────────────────────────────────────────────
 * WHEN THIS GOES RED
 * ─────────────────────────────────────────────────────────────────────────────
 * · You added an `AppListing` mutation → either call `bustAppListingCatalogCache()`
 *   from it and add its `<file>::<fn>` to `LEDGER`, or add it to `EXEMPT` with a
 *   one-line reason saying which cached axis it provably does NOT move.
 * · You removed a bust → prove the mutation cannot change catalog membership or a
 *   CACHED axis (`al.status`, `al.kind`, `al.category`, `al.content_rating`,
 *   `al.revision_of_id`, `ab.current_version_deployed_at`, or the `sort_key` inputs
 *   `al.name` / `al.created_at` / the metric rollup) — remembering that every
 *   PROJECTION field on the card is hydrated live and can never be stale — then move
 *   the row from `LEDGER` to `EXEMPT` in the same commit.
 * · You RENAMED the buster → the scan finds zero and the positive control below fires
 *   first, naming the instrument rather than the code.
 * · A site reports `<unattributed>` → the parser could not name its enclosing
 *   function. That is a defect in THIS FILE, not in the code under scan; fix
 *   `classifyBrace` rather than working around it.
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
 * A CALL, not a mention. `stripCommentsAndStrings` removes the prose (this codebase
 * discusses the buster at length in comments), and the `\(` requires an invocation, so
 * the `import { … }` line and the `export async function` definition are both excluded.
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
 * 🔴 THIS IS A BACKWARD PARSE, NOT A PATTERN LIST — because two earlier pattern lists
 * each mis-attributed silently, in a different shape, and a silent wrong name is the
 * worst output this file can produce (it sends the reader to an unrelated function).
 *
 * The shapes that already bit us:
 *   · a two-space-indented `name(` alternative added to name class methods also matched
 *     `  if (` and `  switch (`, so four real mutations were attributed to a function
 *     called `if`;
 *   · dropping that alternative and anchoring at column 0 made class methods invisible
 *     instead: re-adding the bust inside `BlockRegistry.setMarketplaceMeta` reported it
 *     as `block-registry.service.ts::resolveRenderMode`, an unrelated top-level helper
 *     forty lines earlier — while a comment at that call site instructs a future
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

const TYPE_CHARS = /[\w$\s.<>,[\]|&?]/;
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

const buildFrames = (code: string): Frame[] => {
  const frames: Frame[] = [];
  const stack: Frame[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') {
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
      const frame = stack.pop();
      if (frame) frame.end = i;
    }
  }
  return frames;
};

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

/** `{ busts, writes }` — both as sorted, de-duplicated `<file>::<fn>` sets. */
const scan = (files: string[]) => {
  const busts: string[] = [];
  const writes: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    // Cheap pre-filter: skip the ~99% of files that mention neither.
    if (!source.includes('bustAppListingCatalogCache') && !source.includes('appListing.')) continue;
    const code = stripCommentsAndStrings(source);
    CALL_RE.lastIndex = 0;
    WRITE_RE.lastIndex = 0;
    const bustHits = [...code.matchAll(CALL_RE)].filter(
      // 🔴 The buster's own DECLARATION in `app-listing.service` matches `name\s*\(` too.
      (m) => !/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 40), m.index))
    );
    const writeHits = [...code.matchAll(WRITE_RE)];
    if (!bustHits.length && !writeHits.length) continue;
    const frames = buildFrames(code);
    for (const m of bustHits) busts.push(`${file}::${attribute(frames, m.index)}`);
    for (const m of writeHits) writes.push(`${file}::${attribute(frames, m.index)}`);
  }
  return {
    busts: [...new Set(busts)].sort(),
    writes: [...new Set(writes)].sort(),
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
 * The bar for a row here is that the write provably cannot move a CACHED axis of the
 * `/apps` keyset statement. That statement reads exactly: `al.id`, `al.status`,
 * `al.revision_of_id`, `al.kind`, `al.category`, `al.content_rating` (via
 * `listingMatureFilter`), `ab.current_version_deployed_at`, and the `sort_key` inputs
 * (`al.name`, `al.created_at`, the `app_listing_metrics` rollup). It reads NOTHING
 * else — every other column on the card is hydrated live below the cache and can never
 * be served stale.
 *
 * Each reason below was re-derived against the code at this commit, not inherited.
 */
const EXEMPT: Record<string, string> = {
  'src/server/services/blocks/app-listing-assets.service.ts::backfillListingAssets':
    'writes only `coverId` / `iconId`, both hydrated projection fields — no cached axis.',
  'src/server/services/blocks/app-listing-assets.service.ts::reDeriveContentRatingForModLiveEdit':
    'DOES raise `content_rating`, but it is an in-tx helper with exactly three callers ' +
    '(`setListingIcon`, `setListingCover`, `addListingScreenshot`) and all three bust ' +
    'post-commit — a bust inside the tx would also fire on a rollback.',
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

describe('🔴 /apps catalog freshness ledger', () => {
  const { busts: SITES, writes: WRITERS } = scan(FILES);

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
    const frames = buildFrames(code);
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
