import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The surfaces LISTED below still run `throwOnBlockedUserContent`, and nothing reachable falls
 * back to the weaker check.
 *
 * ⚠️ Read that scope literally. This does NOT prove "every surface that stores user text is
 * guarded", and an earlier version of this docstring claimed exactly that. Both halves key on a
 * file's IMPORTS, so a writer that calls neither function is invisible here — several were, and
 * were found by a reviewer reading the router tree rather than by this test. Adding a surface to
 * `SURFACES` is a human act; this file protects what is already listed, it does not discover.
 *
 * 🔴 WHAT THE LEDGER BELOW CERTIFIES, EXACTLY: that these calls are present, and attributed to
 * these writers. NOT that these are all the writers of a file, and NOT that a writer scans every
 * field it persists. It counts CALLS, not ARGUMENTS — a writer guarding two of the three fields
 * it writes is invisible to every count and every name here, which is how `upsertUserHub` sat in
 * this map, green, while `sources[].alias` went unscanned. A per-writer count says a writer was
 * guarded; it never says it was guarded completely.
 *
 * Three review passes each found writers the previous pass missed, so the enumeration should be
 * assumed OPEN. It is tracked as ClickUp 868kz1yt1: walk the write call sites once, then every
 * writer either calls the guard and appears below, or carries a stated reason it does not. Until
 * that lands, a green run here means "what is listed is still wired", nothing wider.
 *
 * 868kw6t61. Nine surfaces called `throwOnBlockedLinkDomain` and stopped there, so they enforced
 * one of the two blocklists over the raw stored string while comments ran both over several
 * normalised forms. The unit tests around the guard cannot see this class of defect at all: they
 * prove the guard works, and say nothing about whether a surface still calls it.
 *
 * 🔴 The dangerous edit is not a deletion, it is a SWAP. `throwOnBlockedLinkDomain` is still
 * exported and still correct for what it does, so reverting a call site to it type-checks, runs
 * green, and reads in review as a tidy-up — while silently dropping the pattern list and both
 * normalisation steps. That is why this asserts on the banned symbol as well as the required one.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BLOCKLIST_MODULE = 'blocklist.service';

const REQUIRED = 'throwOnBlockedUserContent';
const BANNED = 'throwOnBlockedLinkDomain';

/**
 * Surface → how many separate writers of that surface's text must run the guard.
 *
 * The counts are not decoration. Several of these files check the text TWICE — once as the client
 * sent it, and again after other content is spliced into it, which is a different string reaching
 * a different write. A count of 1 would let the second call be deleted with the guard test still
 * green, and that second call is the one with no user in the loop to notice.
 */
const SURFACES: Record<string, number> = {
  'src/server/services/apps/shared-content-safety.ts': 1,
  'src/server/services/article.service.ts': 4,
  'src/server/services/blurb.service.ts': 2,
  'src/server/services/bounty.service.ts': 3,
  'src/server/services/bountyEntry.service.ts': 1,
  'src/server/services/collection.service.ts': 1,
  'src/server/services/cosmetic-shop.service.ts': 3,
  'src/server/services/creator-announcement.service.ts': 1,
  'src/server/services/model-version.service.ts': 4,
  'src/server/services/model.service.ts': 3,
  'src/server/services/model3d-review.service.ts': 1,
  'src/server/services/model3d.service.ts': 1,
  'src/server/services/post.service.ts': 2,
  'src/server/services/resourceReview.service.ts': 3,
  'src/server/services/user-hub.service.ts': 2,
  'src/server/services/user-link.service.ts': 2,
  'src/server/services/user-profile.service.ts': 1,
};

/**
 * Files allowed to keep the link-only check, each for a stated reason. An entry here is a claim
 * that the surface does NOT carry ordinary user-authored text, so adding one is a decision.
 */
const LINK_ONLY_ALLOWED: Record<string, string> = {
  'src/server/controllers/chat.controller.ts':
    'chat edit — runs throwOnBlockedMessagePattern on the same string, so both lists apply',
  'src/server/services/chat.service.ts':
    'already runs both lists — it calls throwOnBlockedMessagePattern beside the link check',
  'src/server/services/blocks/app-moderator-message.service.ts':
    'moderator-authored message to an app developer',
  'src/server/services/blocklist.service.ts': 'defines both functions',
};

/**
 * Which function in each file holds the calls. Named rather than counted, so moving a call from
 * one writer to another fails naming both — the shape a bare total cannot see.
 *
 * 🔴 DERIVE THESE FROM THE INVARIANT, NEVER FROM THE TREE. The invariant is: every writer of a
 * surface's user-authored text guards once, and a writer that splices other content into that
 * text afterwards guards a second time on the spliced result — which is why the entries reading
 * `2` are exactly the upserts that expand snippets, and every `applyXContentChange` fan-out reads
 * `1`.
 *
 * Generating this map by walking the current code is how the previous version of this file
 * recorded a `1` for a writer that had no check at all: the count did not merely miss the gap, it
 * pinned the gap as intended and then defended it against the next person who noticed. A number
 * with a test behind it reads as a decision somebody made. Make it one.
 */
const EXPECTED_WRITERS: Record<string, Record<string, number>> = {
  'src/server/services/apps/shared-content-safety.ts': { assertSharedTextSafe: 1 },
  'src/server/services/article.service.ts': {
    applyArticleContentChange: 1,
    createArticleRatingReview: 1,
    upsertArticle: 2,
  },
  'src/server/services/blurb.service.ts': { createBlurb: 1, updateBlurbContent: 1 },
  'src/server/services/bounty.service.ts': { applyBountyContentChange: 1, upsertBounty: 2 },
  'src/server/services/bountyEntry.service.ts': { upsertBountyEntry: 1 },
  'src/server/services/collection.service.ts': { upsertCollection: 1 },
  'src/server/services/cosmetic-shop.service.ts': {
    applyCosmeticShopItemContentChange: 1,
    upsertCosmeticShopItem: 2,
  },
  'src/server/services/creator-announcement.service.ts': { upsertCreatorAnnouncement: 1 },
  'src/server/services/model-version.service.ts': {
    applyModelVersionContentChange: 1,
    upsertExplorationPrompt: 1,
    upsertModelVersion: 2,
  },
  'src/server/services/model.service.ts': { applyModelContentChange: 1, upsertModel: 2 },
  'src/server/services/model3d-review.service.ts': { upsertModel3DReview: 1 },
  'src/server/services/model3d.service.ts': { upsertModel3D: 1 },
  'src/server/services/post.service.ts': { createPost: 1, updatePost: 1 },
  'src/server/services/resourceReview.service.ts': {
    createResourceReview: 1,
    updateResourceReview: 1,
    upsertResourceReview: 1,
  },
  'src/server/services/user-hub.service.ts': { addUserHubSource: 1, upsertUserHub: 1 },
  'src/server/services/user-link.service.ts': { upsertManyUserLinks: 1, upsertUserLink: 1 },
  'src/server/services/user-profile.service.ts': { updateUserProfile: 1 },
};

function read(rel: string) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

function parse(rel: string) {
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
}

/**
 * Local names bound to an export of `blocklist.service`, so a rename-on-import cannot dodge
 * either half of this. `import { throwOnBlockedLinkDomain as check }` is a one-line edit that a
 * grep for the symbol reports as clean.
 */
function importedNames(source: ts.SourceFile, exported: string): string[] {
  const names: string[] = [];
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    if (!node.moduleSpecifier.text.includes(BLOCKLIST_MODULE)) return;

    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;

    for (const element of bindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      if (importedName === exported) names.push(element.name.text);
    }
  });
  return names;
}

/**
 * Calls grouped by the FUNCTION that contains them, not counted per file.
 *
 * A file-wide total is satisfiable by the wrong arrangement: move both of a file's calls into one
 * writer, or delete a post-expansion re-check while adding a call anywhere else, and the total is
 * unchanged while a writer goes unguarded. That is the same "swap that reads as a tidy-up" this
 * file exists to catch, so counting per file would have left the hole open in the guard itself.
 */
function callsByFunction(source: ts.SourceFile, names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (!names.length) return counts;

  const visit = (node: ts.Node, enclosing: string, depth: number) => {
    let scope = enclosing;
    let nextDepth = depth;

    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      nextDepth = depth + 1;
      if (node.name) scope = node.name.getText();
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      // Names the scope but does NOT bump depth — the arrow itself is the function-like node and
      // bumps it a line below. Bumping here too made every `export const x = async () => {}`
      // writer read as depth 2, i.e. as if its guard were buried in a callback.
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) scope = node.name.getText();
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // An anonymous callback — a `.map`, a transaction body. It does not rename the scope, but
      // it does bury it, and `depth` is what makes that visible below.
      nextDepth = depth + 1;
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.includes(node.expression.text)
    ) {
      // 🔴 Depth, not just name. Attribution by nearest NAMED scope alone is forgeable: a local
      // `const createPost = async () => { await guard(); }` declared inside `updatePost` produces
      // the same map as two real top-level writers, so the guard reads as covering a writer that
      // has no call at all. A guard call belongs at the top level of its writer; anything deeper
      // is recorded under a name that fails loudly rather than passing quietly.
      const key = depth === 1 ? scope : `${scope} (nested, depth ${depth})`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    node.forEachChild((child) => visit(child, scope, nextDepth));
  };

  source.forEachChild((node) => visit(node, '<module>', 0));
  return counts;
}

/**
 * Everywhere a writer plausibly lives, so a NEW one cannot be added holding the weaker check.
 *
 * Routers and controllers are swept as well as services: `chat.controller.ts` calls the link-only
 * function directly, so "writers only ever live in services" was never true, and a sweep of the
 * services directory alone would have reported a clean result while missing it.
 */
const SWEPT_DIRS = ['src/server/services', 'src/server/routers', 'src/server/controllers'];

function sweptFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(rel);
      } else if (entry.name.endsWith('.ts')) out.push(rel);
    }
  };
  for (const dir of SWEPT_DIRS) walk(dir);
  return out;
}

describe('no unguarded user-authored text', () => {
  it.each(Object.entries(SURFACES))('%s runs the guard in every writer', (rel, expected) => {
    const source = parse(rel);
    const names = importedNames(source, REQUIRED);

    expect(
      names.length,
      `${rel} does not import ${REQUIRED} from ${BLOCKLIST_MODULE}`
    ).toBeGreaterThan(0);

    const byFunction = callsByFunction(source, names);
    const total = [...byFunction.values()].reduce((sum, n) => sum + n, 0);

    // Both, and the second is the one with teeth: the total alone is satisfied by moving a call
    // from one writer into another, which leaves a writer unguarded with the count unchanged.
    expect(
      total,
      `${rel} should call ${REQUIRED} ${expected}x — a writer of this surface's text has lost its check`
    ).toBe(expected);
    expect(
      Object.fromEntries([...byFunction].sort()),
      `${rel}: the guard calls moved between functions. Same total, different writers — check which writer lost its call`
    ).toEqual(EXPECTED_WRITERS[rel]);
  });

  it.each(Object.keys(SURFACES))('%s does not fall back to the link-only check', (rel) => {
    expect(
      importedNames(parse(rel), BANNED),
      `${rel} imports ${BANNED}. That check reads one of the two lists, over the raw string only — swapping ${REQUIRED} for it is the revert this guard exists to catch`
    ).toEqual([]);
  });

  /**
   * The half that catches a surface nobody thought to list. Without it a new service added next
   * month with the weaker check is invisible here, and the guard reports a clean sweep of the
   * files it already knew about — the shape that makes a guard read as coverage it does not have.
   */
  it('nothing outside the stated exceptions still uses the link-only check', () => {
    const offenders = sweptFiles().filter(
      (rel) => !(rel in LINK_ONLY_ALLOWED) && importedNames(parse(rel), BANNED).length > 0
    );

    expect(
      offenders,
      `these call ${BANNED} without being listed as an exception. Either switch them to ${REQUIRED} and add them to SURFACES, or record why the surface carries no user-authored text in LINK_ONLY_ALLOWED`
    ).toEqual([]);
  });

  /**
   * A stale exception is worse than none: it keeps permitting something already fixed, and the
   * next reader takes the list as a description of the code.
   */
  it('every stated exception is still real', () => {
    const stale = Object.keys(LINK_ONLY_ALLOWED).filter(
      (rel) =>
        rel !== 'src/server/services/blocklist.service.ts' &&
        importedNames(parse(rel), BANNED).length === 0
    );

    expect(
      stale,
      'these no longer use the link-only check — remove them from LINK_ONLY_ALLOWED'
    ).toEqual([]);
  });
});
