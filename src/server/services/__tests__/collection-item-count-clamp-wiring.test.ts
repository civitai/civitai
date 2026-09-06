import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * 🔴 CALL-SITE LEDGER for `getCollectionItemCount`'s `browsingLevel` clamp.
 *
 * The parameter is OPTIONAL, which is what makes every existing caller safe — and
 * is also exactly why nothing else can see a caller that should have passed it and
 * did not. There is no compile error, no runtime error, and no failing assertion:
 * the call simply returns the UNCLAMPED total, and a discovery card goes back to
 * advertising thousands of items the player will not serve. That is the original
 * defect, restored silently, by a caller written months from now.
 *
 * So the population is pinned here: every call site in `src/`, enumerated from the
 * TREE rather than from a list someone maintains, keyed by
 * `file::enclosingFunction`, with — in source order — whether each one clamps.
 * Adding, removing or re-clamping a call site is then a REVIEWABLE EDIT to this
 * table rather than an invisible change.
 *
 * 🔴 THE PIN IS A LIST, NOT A COUNT, BECAUSE ONE KEY COVERS SEVERAL CALLS. The
 * blocks discovery handler issues THREE: an unclamped "advertised" count, a
 * clamped "playable" one on the public branch, and a clamped one on `mine`. A
 * per-key boolean could not distinguish "the advertised call lost its clamp"
 * (correct) from "the playable call lost its clamp" (the bug), because both keys
 * would still read "mixed". A per-key COUNT could not see a clamped call being
 * swapped for an unclamped one at all. The ordered list sees both.
 *
 * MECHANISM: the TypeScript AST, not a regex. Call sites are matched by
 * IDENTIFIER (so a `mockGetCollectionItemCount(...)` is not a call to
 * `getCollectionItemCount`, which a substring needle cannot distinguish) and the
 * clamp is read as a PROPERTY of the argument object, so a prettier reflow, a
 * renamed local or a comment mentioning the parameter cannot change the answer.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const NEEDLE = 'getCollectionItemCount';

/** The declaration itself — not a call site. */
const DEFINITION_FILE = 'src/server/services/collection.service.ts';
/**
 * This guard's own source. It mentions the needle only in comments and string
 * literals, which the AST walk already ignores, but it is excluded by path as
 * well so the enumeration can never depend on that.
 */
const GUARD_FILE = 'src/server/services/__tests__/collection-item-count-clamp-wiring.test.ts';

/** The optional parameter whose presence at a call site this ledger tracks. */
const CLAMP_PARAM = 'browsingLevel';

/**
 * What a call site does with {@link CLAMP_PARAM}.
 *
 * `unreadable` is the deliberately conservative bucket: an argument that is not a
 * plain object literal (a spread, a variable, a helper's return value) cannot be
 * read statically, so it fails every pin rather than being guessed at. If a future
 * caller legitimately needs that shape, the fix is to make the clamp visible at the
 * call site — not to loosen this.
 */
type ClampState = 'clamped' | 'unclamped' | 'unreadable';

interface CallSite {
  /** Repo-relative path. */
  file: string;
  /** Nearest named enclosing function / method / `const fn = () =>`. */
  fn: string;
  /** 1-based line of the call, for a failure message a human can act on. */
  line: number;
  clamp: ClampState;
}

/** `file::enclosingFunction` — the key the expectation table is written in. */
type CallSiteKey = string;

interface ExpectedCallSite {
  /**
   * Every call under this key, IN SOURCE ORDER, and whether it clamps.
   *
   * 🔴 CHANGING AN ENTRY IS THE REVIEWABLE ACT. Flipping a `'clamped'` to
   * `'unclamped'` is asserting that this particular count is meant to be the
   * ADVERTISED total — the denominator of the playable fraction — and not a number
   * anything renders. Adding an entry is asserting the same for a new call.
   */
  clamps: readonly ClampState[];
  /** What those calls ARE, so a mismatch message can name the one that moved. */
  siteNote: string;
}

/**
 * Every PRODUCTION call site of `getCollectionItemCount`.
 *
 * 🔴 THE THREE UNCLAMPED ROWS ARE NOT OVERSIGHTS. They are the surfaces that
 * predate the clamp and must keep their present behaviour byte for byte: the
 * public REST collections list, the on-site infinite-scroll controller, and the
 * model showcase card. Each renders a count to a viewer whose maturity ceiling is
 * enforced elsewhere in that surface's own pipeline; changing what they count is a
 * separate, deliberate change to those surfaces, not a side effect of this one.
 */
const EXPECTED_BY_CALL_SITE: Record<CallSiteKey, ExpectedCallSite> = {
  'src/pages/api/v1/blocks/collections/index.ts::handler': {
    // Source order: the two public-branch counts inside one `Promise.all`, then
    // the `mine`-branch count.
    clamps: ['unclamped', 'clamped', 'clamped'],
    siteNote:
      "public branch: (1) the ADVERTISED count — the floor's denominator, deliberately unclamped; " +
      "(2) the PLAYABLE count, clamped, which is both the floor's numerator and the rendered " +
      'itemCount; then (3) the `mine` branch count, clamped because the number must agree with ' +
      'the player in every mode (only the DROP is discovery-only)',
  },
  'src/pages/api/v1/collections/index.ts::handler': {
    clamps: ['unclamped'],
    siteNote: 'the public REST collections list — pre-existing surface, behaviour unchanged',
  },
  'src/server/controllers/collection.controller.ts::getAllCollectionsInfiniteHandler': {
    clamps: ['unclamped'],
    siteNote: 'the on-site infinite collection feed — pre-existing surface, behaviour unchanged',
  },
  'src/server/controllers/model.controller.ts::getModelCollectionShowcaseHandler': {
    clamps: ['unclamped'],
    siteNote:
      "the model page's showcase-collection card — pre-existing surface, behaviour unchanged",
  },
};

/** Total pinned call sites — the floor the enumeration guard must clear. */
const EXPECTED_TOTAL_SITES = Object.values(EXPECTED_BY_CALL_SITE).reduce(
  (n, pin) => n + pin.clamps.length,
  0
);

/**
 * Candidate files, enumerated from the TREE rather than from a hand-kept list.
 *
 * The needle is the BARE identifier: it only has to over-approximate, because the
 * AST walk below decides what is really a call. That removes every formatting
 * dependency from the enumeration.
 */
function candidateFiles(): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (
        /\.tsx?$/.test(entry.name) &&
        readFileSync(path.join(REPO_ROOT, child), 'utf8').includes(NEEDLE)
      )
        found.push(child);
    }
  };
  walk('src');
  return found
    .filter((f) => f !== DEFINITION_FILE && f !== GUARD_FILE)
    .filter((f) => !(f.includes('__tests__') || /\.test\.tsx?$/.test(f)));
}

/**
 * The nearest NAMED enclosing scope of `node`, walking up the parent chain.
 *
 * Handles the shapes this repo uses at these call sites:
 *   - `async function handler(req, res) {}` passed to a wrapper → FunctionExpression
 *   - `export const getAllCollectionsInfiniteHandler = async () => {}` → VariableDeclaration
 *   - `export async function getModelCollectionShowcaseHandler() {}` → FunctionDeclaration
 *
 * A name is only accepted from a variable/property once a function boundary has
 * been crossed, so a call sitting directly in an object literal is not mislabelled
 * as "inside" it.
 */
function enclosingFunctionName(node: ts.Node): string {
  let sawFunctionBoundary = false;
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur)) {
      if (cur.name) return cur.name.text;
      sawFunctionBoundary = true;
    } else if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    } else if (ts.isFunctionExpression(cur)) {
      if (cur.name) return cur.name.text;
      sawFunctionBoundary = true;
    } else if (ts.isArrowFunction(cur)) {
      sawFunctionBoundary = true;
    } else if (sawFunctionBoundary && ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    } else if (sawFunctionBoundary && ts.isPropertyAssignment(cur) && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    }
    cur = cur.parent;
  }
  return '<module scope>';
}

/** Does the call's single object-literal argument carry a `browsingLevel` key? */
function clampStateOf(arg: ts.Expression | undefined): ClampState {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return 'unreadable';
  for (const prop of arg.properties) {
    // A spread could carry the key invisibly — refuse to guess.
    if (ts.isSpreadAssignment(prop)) return 'unreadable';
    const name = prop.name;
    if (!name) continue;
    // A computed key could also be `browsingLevel` at runtime — refuse to guess.
    if (ts.isComputedPropertyName(name)) return 'unreadable';
    if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === CLAMP_PARAM)
      return 'clamped';
  }
  return 'unclamped';
}

/** Every real `getCollectionItemCount(...)` call in `file`, in source order. */
function callSitesIn(file: string): CallSite[] {
  const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found: CallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // Identifier equality — NOT a substring match.
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
        ? callee.name.text
        : null;
      if (calleeName === NEEDLE) {
        found.push({
          file,
          fn: enclosingFunctionName(node),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          clamp: clampStateOf(node.arguments[0]),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // `forEachChild` is a pre-order walk, so `found` is already in source order
  // within a file; sorting by line makes that independent of the traversal.
  return found.sort((a, b) => a.line - b.line);
}

const keyOf = (c: CallSite): CallSiteKey => `${c.file}::${c.fn}`;

describe('getCollectionItemCount — browsingLevel call-site ledger', () => {
  // A throw in the describe BODY happens during registration, so no `it` below
  // would be declared and the file would collect zero tests while READING GREEN.
  // Catching it keeps registration total, so the guard below reports the breakage.
  let sites: CallSite[] = [];
  let enumerationError: unknown;
  try {
    sites = candidateFiles().flatMap(callSitesIn);
  } catch (e) {
    enumerationError = e;
  }

  it('finds the call sites at all (guard the guard)', () => {
    if (enumerationError) throw enumerationError;
    // Without this, a broken enumeration would make every assertion below pass
    // vacuously over an empty list.
    expect(sites.length).toBeGreaterThanOrEqual(EXPECTED_TOTAL_SITES);
    // And no call site may resolve to an unnamed scope — that would collapse
    // distinct handlers onto one key.
    expect(sites.filter((c) => c.fn === '<module scope>')).toEqual([]);
  });

  it('🔴 no UNEXPECTED call site — a new caller must declare whether it clamps', () => {
    const unexpected = sites
      .filter((c) => !(keyOf(c) in EXPECTED_BY_CALL_SITE))
      .map((c) => `${c.file}:${c.line} inside ${c.fn}() [${c.clamp}]`);
    expect(unexpected).toEqual([]);
  });

  it('🔴 every pinned key has EXACTLY the calls it claims, clamped exactly as it claims', () => {
    const liveByKey = new Map<CallSiteKey, CallSite[]>();
    for (const c of sites) {
      const bucket = liveByKey.get(keyOf(c));
      if (bucket) bucket.push(c);
      else liveByKey.set(keyOf(c), [c]);
    }

    const wrong = Object.entries(EXPECTED_BY_CALL_SITE)
      .map(([key, pin]) => {
        const live = liveByKey.get(key) ?? [];
        const actual = live.map((c) => c.clamp);
        if (
          actual.length === pin.clamps.length &&
          actual.every((state, i) => state === pin.clamps[i])
        )
          return null;
        return (
          `${key}\n  expected [${pin.clamps.join(', ')}]\n  found    [${actual.join(', ')}]` +
          `${
            live.length ? ` at line(s) ${live.map((c) => c.line).join(', ')}` : ' (no calls found)'
          }` +
          `\n  the pinned calls are: ${pin.siteNote}`
        );
      })
      .filter((m): m is string => m !== null);

    expect(wrong).toEqual([]);
  });

  it('no call site passes an argument this guard cannot read', () => {
    // `unreadable` means the clamp is invisible to review. It fails the pin above
    // anyway; this reports it in its own terms rather than as a confusing
    // "expected clamped, found unreadable".
    const opaque = sites
      .filter((c) => c.clamp === 'unreadable')
      .map(
        (c) =>
          `${c.file}:${c.line} inside ${c.fn}() passes a non-literal argument — ` +
          `pass a plain object literal so the '${CLAMP_PARAM}' decision is visible at the call site`
      );
    expect(opaque).toEqual([]);
  });
});
