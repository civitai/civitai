import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every surface that stores user-authored text runs `throwOnBlockedUserContent`.
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
  'src/server/services/article.service.ts': 3,
  'src/server/services/blurb.service.ts': 2,
  'src/server/services/bounty.service.ts': 3,
  'src/server/services/bountyEntry.service.ts': 1,
  'src/server/services/model-version.service.ts': 3,
  'src/server/services/model.service.ts': 3,
  'src/server/services/model3d-review.service.ts': 1,
  'src/server/services/model3d.service.ts': 1,
  'src/server/services/post.service.ts': 1,
  'src/server/services/resourceReview.service.ts': 1,
  'src/server/services/user-profile.service.ts': 1,
  'src/server/services/apps/shared-content-safety.ts': 1,
};

/**
 * Files allowed to keep the link-only check, each for a stated reason. An entry here is a claim
 * that the surface does NOT carry ordinary user-authored text, so adding one is a decision.
 */
const LINK_ONLY_ALLOWED: Record<string, string> = {
  'src/server/services/chat.service.ts':
    'already runs both lists — it calls throwOnBlockedMessagePattern beside the link check',
  'src/server/services/cosmetic-shop.service.ts':
    'moderator-authored shop copy, not user-authored text',
  'src/server/services/blocks/app-moderator-message.service.ts':
    'moderator-authored message to an app developer',
  'src/server/services/blocklist.service.ts': 'defines both functions',
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

function countCalls(source: ts.SourceFile, names: string[]) {
  if (!names.length) return 0;
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      if (names.includes(node.expression.text)) count++;
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return count;
}

/** Every service file, so a NEW surface cannot be added holding the weaker check. */
function allServiceFiles(): string[] {
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
  walk('src/server/services');
  return out;
}

describe('no unguarded user-authored text', () => {
  it.each(Object.entries(SURFACES))('%s runs the guard on every writer', (rel, expected) => {
    const source = parse(rel);
    const names = importedNames(source, REQUIRED);

    expect(
      names.length,
      `${rel} does not import ${REQUIRED} from ${BLOCKLIST_MODULE}`
    ).toBeGreaterThan(0);
    expect(
      countCalls(source, names),
      `${rel} should call ${REQUIRED} ${expected}x — a writer of this surface's text has lost its check`
    ).toBe(expected);
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
  it('no service outside the stated exceptions still uses the link-only check', () => {
    const offenders = allServiceFiles().filter(
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
