import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * THE RELAY CALLER LEDGER — the set of modules that can reach
 * `/api/v1/image-upload/relay`, asserted as a set so it fails when it GROWS or SHRINKS.
 *
 * WHY THIS FILE EXISTS. `civitai_image_upload_relay_total` gained a `producer` label so the
 * relay's two callers could be told apart: before it, the counter's non-zero `success` was
 * attributable entirely to the older single-PUT path, and grading the newer multipart path
 * on it returned a confident false positive. Every other guard around that change bounds
 * ONE component. None of them can see a THIRD caller appear — and a third caller is how
 * the defect comes back: `postImageUploadRelay`'s `producer` parameter is typed to the
 * CLIENT-DECLARABLE producers, so a new call site must reuse `single_put` or `multipart` to
 * compile and its traffic is then added to a row someone is already grading. (⚠ That
 * parameter used to be typed to the full LABEL union, which made this sentence false — a
 * caller could declare `unknown`, the row a rollout is graded on.)
 *
 * 🔴 IT LEDGERS REFERENCES, NOT CALL SHAPES — and that is the whole design, arrived at the
 * hard way. Three earlier versions tried to recognise a CALL: first by text
 * (`postImageUploadRelay(<identifier>, {`), then by AST with a binding set closed under
 * aliasing, then with `.call`/`.bind`/`?:`/`??`/object-property resolution bolted on. Each
 * round of review planted a live third caller the current version could not see — measured
 * escapes included `postImageUploadRelay(o.file, …)`, an aliased import, a namespace call,
 * `(0, postImageUploadRelay)(…)`, `settlement.postImageUploadRelay.call(…)` and
 * `Reflect.apply`. The shape space is open, so recognising shapes is a losing game, and
 * every version of that game read as coverage while being walkable.
 *
 * A REFERENCE cannot be walked the same way. To reach the relay from a new module you must
 * either NAME ONE OF THE HELPER MODULE'S RELAY ENTRY POINTS somewhere in it — an alias
 * still writes it in the import clause, a namespace call still writes it at the member
 * access, `(0, f)` still needs the binding — or write the PATH. So this asserts:
 *
 * 🔴 ENTRY POINTS, PLURAL, AND GETTING THAT WRONG COST THE LEDGER ITS WHOLE CLAIM. An
 * earlier revision tracked `postImageUploadRelay` alone and said so in this very paragraph.
 * But `upload-settlement.ts` exports a SECOND way to reach the relay — `relayImageFallback`
 * — which calls the first internally, so a module importing it reaches the relay while
 * naming neither hint. That is not an exotic shape: it is how the REAL second caller
 * already does it. `src/hooks/useS3Upload.tsx` imports `relayImageFallback`, and it was
 * NOT IN THE LEDGER, so a test named "finds EVERY module that can reach the relay" was
 * green while omitting one of the two callers this entire change is about — and a planted
 * third caller written the same way was invisible.
 *
 * THE RULE: every EXPORTED function in the helper module that transitively reaches the
 * relay `fetch` is an entry point and belongs in `HELPER_EXPORTS`. ⚠ That sentence used to
 * be the WHOLE fix, and prose is not a guard — measured, adding a third export plus a
 * consumer importing only it left every test green. It is now ENFORCED: the module's
 * exports are enumerated from the AST, and each must be classified as an entry point or
 * listed in `HELPER_NON_ENTRY_POINTS` with a reason. Adding any export fails until the
 * author decides which it is.
 *
 *   1. the set of production modules that reference an entry point, or name the path in
 *      code, is exactly the ledger;
 *   2. the helper module names its path constant exactly twice — its declaration and its
 *      one use — which is what stops a SECOND relay request being written there using that
 *      constant, a shape that references nothing new; and
 *   3. every export of the helper module is classified, so `HELPER_EXPORTS` cannot silently
 *      fall behind the module it describes.
 *
 * ⚠ (2) bounds USES OF THE CONSTANT, not requests: a one-line `relayUrl()` indirection
 * keeps the count at two while adding a second request. (3) bounds NEW REACHABLE ENTRY
 * POINTS — a second request has to be exported to be reachable, and an unclassified export
 * fails. Neither bounds a second request added INSIDE an existing entry point, which needs
 * no new export at all; that one is bounded BEHAVIOURALLY, by the exact-headers assertions
 * in `src/utils/__tests__/upload-settlement.test.ts` and the hook-level case in
 * `src/hooks/__tests__/useS3Upload.test.ts`. Measured: planting it turns three of those
 * red and nothing in this file. Do not read (3) as covering it.
 *
 * It answers "who CAN reach the relay", never "with what arguments" — so it is
 * deliberately silent about which producer each caller declares. That claim is behavioural
 * and is pinned where it can be observed for real, by driving each hook:
 * `src/hooks/__tests__/useCFImageUpload.test.ts` and
 * `src/hooks/__tests__/useS3Upload.test.ts`, both mutation-verified.
 *
 * `src/server/services/__tests__/no-unledgered-settle-caller.test.ts` is this repo's worked
 * example of a structural call ledger, and it is the right model when the ARGUMENTS matter.
 * ⚠ Earlier revisions of this file claimed parity with its binding resolution. They did not
 * have it, and the claim is gone rather than softened: this file resolves no bindings at
 * all, because it does not need to.
 *
 * 🔴 WHAT IS STILL OUT OF REACH — stated because it is open, not softened:
 *   - A name assembled by CONCATENATION (`mod['post' + 'ImageUploadRelay']`) appears
 *     nowhere as one token. Nothing short of type-checking sees that, and it is not a
 *     shape anyone writes by accident. ⚠ This bullet used to read "a computed property
 *     access", which is WIDER than what is actually out of reach and covered the
 *     string-literal access `mod['postImageUploadRelay']` — a shape that WAS invisible,
 *     was found live, and is now matched. A limits list that overstates its own hole is
 *     worse than one that omits it: it makes the escape look already-considered.
 *   - A path assembled so that the matched tail never appears as one literal
 *     (`'/api/v1/image-upload' + '/relay'`). Pinned by a case below, so closing it makes
 *     that case fail and this line gets updated.
 *   - Reachability is not evaluated: a call behind a flag still counts as a reference.
 *   - `export * from './x'` is not enumerated as an export of THIS module. A re-export
 *     barrel in the helper module would therefore not be classified. Measured: planting one
 *     still turned the ledger red, but via the SIBLING module appearing in the set rather
 *     than via the classification — so the redness is incidental and the consumer importing
 *     the re-exported name stayed invisible. Recorded rather than closed, because resolving
 *     a star export means following the module graph.
 *   - The PREFILTER is a spelling — only files whose raw text mentions the identifier or
 *     the path tail are parsed. Its own control is below, and it is deliberately built on a
 *     hard-coded corpus rather than on `TEXT_HINTS`, because a control that interpolates
 *     the thing under test into its own fixture can never fail.
 *
 * NOT REGRESSION COVERAGE — AN INVARIANT GUARD, LABELLED AS ONE. Nothing at the base commit
 * violates it: the relay has exactly the two CALLERS the producer label rests on. (The
 * ledger itself is longer than two — it also carries the helper module, which is not a
 * caller. Stating a count here for a different set is how this file acquired its third
 * disagreeing number, in the file that wrote the no-counts rule.) The controls at the
 * bottom are what make it a guard that can go red.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * Roots that can hold production TypeScript reaching the relay.
 *
 * `apps`, `packages` and `scripts` are swept as well as `src`: the relay is an ordinary
 * same-origin POST, so a workspace app could make one, and a caller nobody scans is a
 * caller nobody ledgers. ⚠ An earlier revision justified this by citing the settle ledger's
 * widening — whose stated reason is `scripts/` specifically — while omitting `scripts`
 * itself. Cited reasons have to match what the code does.
 *
 * 🔴 `event-engine-common` IS SWEPT, and its absence was a measured escape: a module there
 * importing and calling an entry point left every test in this file green, while the
 * identical file under `packages/` turned the ledger red — so the root list, and nothing
 * else, was the difference. It is a submodule rather than a workspace directory, which is
 * exactly why it did not come to mind; it holds production TypeScript that the server
 * imports, and a raw `fetch` to the path there needs no import at all and so has no second
 * gate. ⚠ A submodule can be UNPOPULATED in a fresh checkout, in which case `walkFiles`
 * tolerates the missing directory and scans nothing — so this root's coverage differs
 * between checkouts. That is a reason to populate it in CI, not a reason to leave it out:
 * scanning it sometimes strictly dominates scanning it never.
 */
const ROOTS = ['src', 'apps', 'packages', 'scripts', 'event-engine-common'];

/**
 * Every file extension the sweep admits — ONE list, feeding the walker, the spec filter and
 * their control.
 *
 * 🔴 SINGLE-SOURCED BECAUSE THE TWO REGEXES DRIFTING APART IS A DEFECT THIS FILE HAS
 * ALREADY SHIPPED. The walker was widened to `.js`/`.mjs`/`.svelte` while the spec filter
 * still said `tsx?$`, so a colocated `*.test.js` naming the helper read as a production
 * caller. Deriving both from this list makes that particular disagreement unrepresentable,
 * which is better than a test that watches for it.
 *
 * ⚠ `.mts`/`.cts` were missing from the walker until measured: a plain named-import caller
 * in an `.mts` file — the STRONGEST reference shape, nothing clever about it — was invisible
 * purely because of its extension. The repo has `.mts` under both swept roots.
 */
const WALKED_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs', 'svelte'];
const EXTENSION_ALTERNATION = WALKED_EXTENSIONS.join('|');
const WALKED_FILE_RE = new RegExp(`\\.(${EXTENSION_ALTERNATION})$`);
const SPEC_FILE_RE = new RegExp(`\\.(test|spec)\\.(${EXTENSION_ALTERNATION})$`);

/** Generated trees, some of which exist only on a developer's machine. */
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.svelte-kit', 'coverage', '.turbo']);

const HELPER_MODULE = 'src/utils/upload-settlement.ts';
/**
 * Every exported name in the helper module that reaches the relay. See the entry-points
 * note in the file docstring — this list being short by one is what let the real multipart
 * caller sit outside the ledger.
 *
 * 🔴 THE EXPORTS DELIBERATELY *NOT* HERE are enumerated in `HELPER_NON_ENTRY_POINTS`
 * below, each with its own reason, so the completeness question does not have to be
 * re-derived and a shape change has the reasoning on record to re-check. Read that map,
 * not a summary here — this paragraph said "THE TWO" while the map held three, which is
 * the failure it was written to prevent: a reader auditing the two named ones and never
 * reaching the third, whose reasoning is the one that differs.
 *
 * The rule the map applies: the test is not "is it exported from this module" but "can
 * calling it, with arguments that name nothing relay-specific, produce a relay request".
 * A callback-taking wrapper cannot — whatever the caller hands it must itself name an
 * entry point or write the path, and that caller is what this ledger sees. If one ever
 * gains a default that builds the request itself, it becomes an entry point.
 */
const HELPER_EXPORTS = ['postImageUploadRelay', 'relayImageFallback'];
/** The same names as a `Set`, for `collectIdentifierRefs`. */
const HELPER_EXPORT_SET: ReadonlySet<string> = new Set(HELPER_EXPORTS);

/**
 * Every OTHER export of the helper module, each with the reason it is not an entry point.
 *
 * 🔴 THIS EXISTS SO `HELPER_EXPORTS` CANNOT GO STALE, and it is the fix for the defect that
 * produced two review rounds in a row. Round 5 found the list short by one. Round 6
 * lengthened it and wrote the rule above in PROSE — and then measured that adding a third
 * export plus a consumer importing only that name left every test green. A convention both
 * sites have to remember is exactly what this file's own argument says is not a guard, and
 * `HELPER_EXPORTS` had become one.
 *
 * So the module's exports are enumerated from the AST and every one must appear in this map
 * or in `HELPER_EXPORTS`. Adding ANY export to the helper module now fails until the author
 * classifies it — which is the moment to ask whether it reaches the relay.
 */
const HELPER_NON_ENTRY_POINTS: Record<string, string> = {
  attachUploadSettlement: 'takes the relay as a callback parameter; makes no request itself',
  relayWithRetry: 'takes the request as a callback parameter; retries whatever it is handed',
  MAX_RETRY_AFTER_SECONDS: 'a number constant; nothing callable, so it makes no request',
};
const RELAY_PATH = '/api/v1/image-upload/relay';
/**
 * The tail, sliced off `RELAY_PATH` so the two cannot disagree about the trailing segments.
 * Matching the tail rather than the whole path is what catches an interpolated base —
 * `` fetch(`${BASE}/image-upload/relay`) ``.
 *
 * ⚠ The `/image-upload/` marker below IS re-typed, so this is only half-derived. Rename
 * that segment and `indexOf` returns -1, `slice(-1)` yields the path's LAST CHARACTER, and
 * the prefilter below becomes a match-on-one-letter that admits nearly the whole tree. It
 * fails loudly rather than silently, but for a reason nobody would connect to a route
 * rename — hence this note rather than a claim that renaming is safe.
 */
const RELAY_PATH_TAIL = RELAY_PATH.slice(RELAY_PATH.indexOf('/image-upload/'));
/** The helper module's own unexported path constant. See `EXPECTED_HELPER_PATH_REFS`. */
const HELPER_PATH_CONSTANT = 'IMAGE_UPLOAD_RELAY_PATH';

/** Prefilter spellings, all derived from the constants above. See the limits list. */
const TEXT_HINTS = [...HELPER_EXPORTS, RELAY_PATH_TAIL.slice(1)];

/**
 * Does this file's raw text earn a parse?
 *
 * Extracted so its control can drive THIS function rather than a copy of the expression.
 * A prefilter that admits nothing is how a third caller goes unseen — an unknown file has
 * no other way into the scan.
 */
function isCandidateText(text: string): boolean {
  return TEXT_HINTS.some((hint) => text.includes(hint));
}

/**
 * THE LEDGER. Compared in BOTH directions: a third module fails it, and so does losing one.
 *
 * Only the real callers are here. Several other modules mention the path in PROSE and are
 * correctly absent — that is the parse earning its keep over a text scan. (No count: two
 * comments in this file gave different ones, which is the class of defect this change has
 * already fixed twice.)
 */
const CALLER_LEDGER = [
  'src/hooks/useCFImageUpload.tsx',
  'src/hooks/useS3Upload.tsx',
  HELPER_MODULE,
];

/**
 * How many times the helper module may name the relay path: the constant's declaration,
 * plus the one use that builds the one request there is.
 *
 * 🔴 A REFERENCE COUNT, NOT A `fetch(` COUNT, and the difference is a measured escape. The
 * previous version counted call expressions whose callee spelled `fetch` — so
 * `globalThis.fetch(IMAGE_UPLOAD_RELAY_PATH, …)` added a second relay request and the
 * assertion stayed green, reopening the hole it was written to close with four characters,
 * in a shape (`window.fetch`) that is ordinary in browser code. It was also the one
 * shape-recognising thing left in a file whose whole argument is that recognising shapes
 * loses. Counting references to the path constant is shape-free, and it stops the
 * assertion firing on an UNRELATED `fetch` added to this module — which the old one did.
 */
const EXPECTED_HELPER_PATH_REFS = 2;

function parse(rel: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.(tsx|jsx)$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function walkFiles(dir: string, out: string[]): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Generated trees. `.svelte-kit`, `coverage` and `.turbo` are gitignored, so they
      // exist on a developer's machine and not in a fresh checkout — without them the
      // sweep's population differs between the two, silently.
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(full, out);
      // Not just `.ts(x)`: `apps/` is SvelteKit, so a workspace app would reach the relay
      // from a `<script>` block, and `.mjs`/`.js` exist under `packages/`. A `.svelte` file
      // is admitted by the text prefilter and then parsed as TS, which is wrong in general
      // but adequate for finding a `fetch` or an import in its script block. Measured: a
      // production `.js` file with a raw relay `fetch` was invisible before this.
    } else if (WALKED_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Production files only.
 *
 * Specs are excluded — a test naming the path is not a caller, and this repo has hundreds
 * of them, colocated as well as under `__tests__`. Both spellings are excluded, because
 * excluding only the directory leaves the colocated ones scanned.
 */
function isProductionFile(rel: string): boolean {
  // Both regexes come from `WALKED_EXTENSIONS`, so the drift described there cannot recur.
  return !rel.includes('__tests__') && !SPEC_FILE_RE.test(rel);
}

/**
 * Is this node in a position that cannot reach the relay at runtime?
 *
 * A module SPECIFIER names a file, a TYPE position names a type, and a type-only import
 * binds nothing. Counting them produced false reds that named a caller which does not
 * exist — loud rather than dangerous, but a guard that cries wolf is one people learn to
 * click through.
 */
function isInertContext(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isImportTypeNode(n) || ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n)) return true;
    if (ts.isImportDeclaration(n)) {
      if (node === n.moduleSpecifier) return true;
      if (n.importClause?.isTypeOnly) return true;
    }
    if (ts.isExportDeclaration(n)) {
      if (node === n.moduleSpecifier) return true;
      if (n.isTypeOnly) return true;
    }
    // ⚠ The INLINE forms — `import { type postImageUploadRelay }` — bind nothing at
    // runtime either, and were missed while the clause-level `isTypeOnly` above was
    // handled. Measured as a false RED that named a caller binding nothing.
    if (ts.isImportSpecifier(n) && n.isTypeOnly) return true;
    if (ts.isExportSpecifier(n) && n.isTypeOnly) return true;
  }
  return false;
}

/**
 * Does this module REFERENCE the relay — by naming the helper, or by naming the path in
 * code?
 *
 * 🔴 An identifier ANYWHERE in the module counts, in any syntactic role, for ANY of the
 * entry points. That is the point: it does not matter whether the reference is a call, an
 * alias, a re-export, a property, a `.call` receiver or a comma sequence — all of them
 * write a name, so this cannot be walked around by choosing a different call shape.
 */
function referencesRelay(sf: ts.SourceFile): { helper: boolean; pathLiterals: number } {
  const helper = collectIdentifierRefs(sf, HELPER_EXPORT_SET).size > 0;
  let pathLiterals = 0;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      node.getText(sf).includes(RELAY_PATH_TAIL) &&
      !isInertContext(node)
    ) {
      pathLiterals += 1;
      return; // counted once per literal; do not descend into a template's spans
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { helper, pathLiterals };
}

/**
 * Every module-level identifier in `sf` whose text is in `names`, ignoring inert positions.
 *
 * 🔴 ONE WALK, THREE CALLERS, and a `Set` rather than an object — both halves are lessons
 * this file paid for. It had three copies of this loop (references, path-constant count,
 * narrowing consumers) and the third diverged: it tested membership with `node.text in
 * found` over an object literal, so an identifier spelled `toString` or `constructor`
 * anywhere in a scanned file crashed the guard with `…includes is not a function`. The
 * module this file guards documents that exact hazard in its own docstring — "a `Set`, not
 * an object literal … an object lookup would answer truthy for `toString`" — and the test
 * guarding it reintroduced it. Consolidating is what made the divergence visible.
 */
function collectIdentifierRefs(sf: ts.SourceFile, names: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text) && !isInertContext(node)) {
      found.add(node.text);
    }
    // 🔴 A STRING SPELLING THE NAME COUNTS TOO, and leaving it out was a live escape.
    // `settlement['postImageUploadRelay'](file, …)` names the entry point at the member
    // access exactly as the docstring above requires — but a string literal is not an
    // `Identifier`, so the check above could not see it. Measured: a compiling third
    // caller written that way, declaring `single_put` and adding traffic to the row the
    // single-PUT path is graded on, left 847 tests green. It is ONE CHARACTER from the
    // `settlement.postImageUploadRelay(…)` shape this file's own control asserts, and it
    // was not the documented limit either — that covers only the CONCATENATED form.
    //
    // Matched in ANY position rather than only under an element access, deliberately: the
    // position space is open in the same way the call-shape space was, and recognising
    // positions is the losing game this file already played three times. The cost is a
    // false red if a production module ever puts an entry point's name in a string for
    // some other reason — loud, cheap, and strictly the right side to err on. It also
    // closes `const k = 'postImageUploadRelay'; mod[k](…)` for free, since that writes
    // the literal too; only concatenation still escapes.
    if (ts.isStringLiteralLike(node) && names.has(node.text) && !isInertContext(node)) {
      found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every identifier a binding name introduces, through object and array patterns. */
function collectBoundNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  // `{ a, b: { c } }` and `[a, , [b]]` — recurse to the leaves. An omitted array element
  // is an `OmittedExpression` and binds nothing.
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) collectBoundNames(el.name, out);
  }
}

/**
 * Every VALUE exported by a module — functions, consts, classes; not types.
 *
 * Types are excluded because a type cannot make a request, and including them would make
 * the classification map a list of names with no bearing on reachability.
 *
 * ⚠ This block spent a round stranded ABOVE `collectIdentifierRefs`, because that function
 * was inserted between the docstring and the function it describes. TypeScript binds only
 * the LAST adjacent block, so the surviving artifact was a dangling paragraph describing
 * exports attached to an identifier walk — the same concatenation-edit class as the
 * orphaned HELP fragment, in JSDoc form. When inserting a function, check what the block
 * above it now documents.
 */
function exportedValueNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  // 🔴 An unnamed default has no identifier to report, so it is spelled `default` — which
  // is also how it must be classified. See the `export default` note below.
  const DEFAULT = 'default';
  const isExported = (node: ts.Node): boolean =>
    !!ts.getCombinedModifierFlags(node as ts.Declaration).valueOf() &&
    (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;

  const visit = (node: ts.Node): void => {
    // 🔴 `node.name` is OPTIONAL here, and requiring it was a live escape. An anonymous
    // `export default function () {}` has none, so the branch skipped it silently — and
    // with it every export-shape check downstream. Measured: an anonymous default calling
    // the helper, plus a consumer importing it, left all 132 tests green.
    if (ts.isFunctionDeclaration(node) && isExported(node)) {
      names.push(node.name ? node.name.text : DEFAULT);
    }
    if (ts.isClassDeclaration(node) && isExported(node)) {
      names.push(node.name ? node.name.text : DEFAULT);
    }
    // 🔴 `export default <expr>` is an ExportAssignment, not a declaration with a modifier,
    // so NONE of the branches above sees it. This is not a hypothetical shape in this repo
    // — `src/utils/lazy-motion.ts` uses it, and no lint rule forbids it. It was the escape
    // that made this guard's "adding ANY export fails" claim false.
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      names.push(DEFAULT);
    }
    if (ts.isVariableStatement(node) && isExported(node)) {
      // 🔴 RECURSES BINDING PATTERNS, and that is round 7's defect one branch over. That
      // round fixed an optional `name` on the function/class branches and left the
      // identical shape here: `if (ts.isIdentifier(decl.name))` silently skipped
      // `export const { go } = api;` and `export const [go] = arr;`. Measured: a
      // destructured export of a relay caller, plus a consumer importing only that name,
      // left all 135 tests green — a live third caller, invisible.
      //
      // This is the commonest export idiom in the repo after a plain const —
      // `src/server/trpc.ts` does `export const { router, middleware, … } = t;` and the
      // context-factory pattern (`export const [Provider, useCtx] = …`) is what a future
      // upload helper would reach for. Fixing the SPELLINGS rather than the SHAPE is how
      // this kept recurring; binding patterns are now walked to their leaves.
      for (const decl of node.declarationList.declarations) {
        collectBoundNames(decl.name, names);
      }
    }
    // `export { a, b }` — a re-export of local bindings, or `export { a } from './x'`,
    // which this branch also matches: there is no `moduleSpecifier` check, deliberately,
    // because either way the name becomes an export of THIS module.
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        if (!el.isTypeOnly && !node.isTypeOnly) names.push(el.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** How many times this module names `IMAGE_UPLOAD_RELAY_PATH`. See `EXPECTED_HELPER_PATH_REFS`. */
function countPathConstantRefs(sf: ts.SourceFile): number {
  // ⚠ Not `collectIdentifierRefs`: this one needs the number of OCCURRENCES, where that
  // helper answers which names appear at all. Different questions, so a different walk.
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === HELPER_PATH_CONSTANT && !isInertContext(node)) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

/** Every production file under `ROOTS`. Shared by the sweep and the narrowing ledger. */
function allProductionFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) walkFiles(path.join(REPO_ROOT, root), files);
  return files.filter((abs) =>
    isProductionFile(path.relative(REPO_ROOT, abs).split(path.sep).join('/'))
  );
}

function scan(): {
  referencing: string[];
  candidates: string[];
  helperPathRefs: number;
  helperExportNames: string[];
  pathLiteralsByFile: Record<string, number>;
} {
  const files = allProductionFiles();

  const referencing: string[] = [];
  const candidates: string[] = [];
  const pathLiteralsByFile: Record<string, number> = {};
  let helperPathRefs = -1;
  let helperExportNames: string[] = [];
  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    const text = fs.readFileSync(abs, 'utf8');
    const ledgered = CALLER_LEDGER.includes(rel);
    // Ledgered files are parsed unconditionally, so the prefilter can never drop one.
    if (!ledgered && !isCandidateText(text)) continue;
    candidates.push(rel);
    const sf = parse(rel, text);
    const { helper, pathLiterals } = referencesRelay(sf);
    if (helper || pathLiterals > 0) referencing.push(rel);
    if (pathLiterals > 0) pathLiteralsByFile[rel] = pathLiterals;
    if (rel === HELPER_MODULE) {
      helperPathRefs = countPathConstantRefs(sf);
      helperExportNames = exportedValueNames(sf);
    }
  }
  return { referencing, candidates, helperPathRefs, helperExportNames, pathLiteralsByFile };
}

describe('the relay caller ledger', () => {
  const { referencing, candidates, helperPathRefs, helperExportNames, pathLiteralsByFile } = scan();

  it('finds EVERY module that can reach the relay, and none outside the ledger', () => {
    expect(referencing.sort()).toEqual([...CALLER_LEDGER].sort());
  });

  it('🔴 keeps the relay path to ONE literal, in the helper module alone', () => {
    // 🔴 THE SET ASSERTION CANNOT SEE THIS, which is why it is separate. A raw `fetch` to
    // the path added INSIDE an already-ledgered file leaves the set unchanged — the file
    // was already in it — so it is invisible to every membership check. Measured as a live
    // escape against the previous version: appending a raw fetch to
    // `src/hooks/useCFImageUpload.tsx` left all six tests green. Counting per FILE is what
    // sees it.
    //
    // The helper owns exactly one, because it builds the one request there is. Every other
    // module owns zero: the path constant is unexported precisely so nobody else can, and
    // spelling it out by hand is the way around that.
    expect(pathLiteralsByFile).toEqual({ [HELPER_MODULE]: 1 });
  });

  it('🔴 keeps the helper module to ONE use of the path constant', () => {
    // 🔴 THE HOLE THIS CLOSES, live until a round-4 review planted it. The path constant is
    // module-local and unexported precisely so no OTHER module can build its own request —
    // but inside this file it is a few lines away, so `fetch(IMAGE_UPLOAD_RELAY_PATH, …)`
    // adds a second relay request while naming no new identifier and writing no new path
    // literal. Every reference-based check above is blind to it by construction.
    //
    // ⚠ And this assertion is the SECOND attempt. The first counted `fetch(` call
    // expressions, which is a call-shape matcher in a file whose argument is that
    // recognising shapes loses — measured, `globalThis.fetch(IMAGE_UPLOAD_RELAY_PATH, …)`
    // walked straight past it, and an UNRELATED `fetch` added to this module turned it red
    // for no reason. Counting references to the constant fixes both.
    expect(
      helperPathRefs,
      `${HELPER_MODULE} must name ${HELPER_PATH_CONSTANT} exactly ${EXPECTED_HELPER_PATH_REFS} ` +
        `times (its declaration, and its one use)`
    ).toBe(EXPECTED_HELPER_PATH_REFS);
  });

  it('🔴 forces EVERY helper-module export to be classified as an entry point or not', () => {
    // 🔴 THE DRIFT GUARD ON `HELPER_EXPORTS`, and the reason this file stopped relying on a
    // prose rule. Measured before it existed: adding a third export to the helper module
    // and a consumer importing only that name left all seven tests green — which is round
    // 5's finding reproduced by the single edit the rule predicted. A convention both sites
    // must remember is what this file's own argument calls not-a-guard.
    //
    // Asserted as an exact SET so it fails when an export is ADDED (unclassified, and the
    // author is made to decide whether it reaches the relay) and when one is REMOVED (a
    // stale entry pointing at nothing).
    const classified = [...HELPER_EXPORTS, ...Object.keys(HELPER_NON_ENTRY_POINTS)].sort();
    expect(
      [...helperExportNames].sort(),
      `every value export of ${HELPER_MODULE} must be listed in HELPER_EXPORTS (it reaches ` +
        `the relay) or in HELPER_NON_ENTRY_POINTS (with the reason it does not)`
    ).toEqual(classified);

    // A name cannot be in both — that would read as "it is an entry point" and "here is why
    // it is not" at once.
    for (const entry of HELPER_EXPORTS) {
      expect(
        HELPER_NON_ENTRY_POINTS[entry],
        `"${entry}" is listed as an entry point AND as a non-entry-point`
      ).toBeUndefined();
    }
    // Every reason is a real sentence, not an empty string standing in for one.
    for (const [name, reason] of Object.entries(HELPER_NON_ENTRY_POINTS)) {
      expect(reason.length, `"${name}" needs a reason, not a placeholder`).toBeGreaterThan(10);
    }
  });

  it('🔴 pins WHICH module uses WHICH of the two narrowings', () => {
    // 🔴 THE TWO NARROWINGS ARE CONFUSABLE BY DESIGN, and choosing wrong in either
    // direction is a shipped defect this change has already measured twice:
    //
    //   `sanitizeImageUploadRelayProducer` narrows CLIENT input against the two declarable
    //   producers. Used by the ROUTE, on the header. Using it on a server-derived value
    //   rewrites every stale-bundle rescue to `other` and empties the row a rollout is
    //   graded on.
    //
    //   `isImageUploadRelayProducer` narrows a value OUR OWN code derived, against the four
    //   labels. Used by the METRIC EMITTER. Using it on a header would accept a client
    //   declaring `unknown` — writing to that same row.
    //
    // Both wrong directions are red today. What was holding the CHOICE for a future site
    // was two docstrings — which is the shape this file spent three rounds proving is not a
    // guard. So the consumer set is pinned like everything else here.
    const NARROWING_CONSUMERS: Record<string, string[]> = {
      sanitizeImageUploadRelayProducer: ['src/pages/api/v1/image-upload/relay.ts'],
      isImageUploadRelayProducer: ['src/server/prom/image-upload-relay.metrics.ts'],
    };
    const DEFINING_MODULE = 'src/utils/image-upload-relay-producer.ts';

    const narrowingNames = new Set(Object.keys(NARROWING_CONSUMERS));
    const found: Record<string, string[]> = {
      sanitizeImageUploadRelayProducer: [],
      isImageUploadRelayProducer: [],
    };
    for (const abs of allProductionFiles()) {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      if (rel === DEFINING_MODULE) continue; // it declares both, by definition
      const text = fs.readFileSync(abs, 'utf8');
      if (![...narrowingNames].some((n) => text.includes(n))) continue;
      const sf = parse(rel, text);
      // 🔴 The SHARED walk, with a `Set`. The open-coded copy this replaced used
      // `node.text in found` over an object literal, so an identifier spelled `toString`
      // or `constructor` in any scanned file crashed the guard.
      for (const name of collectIdentifierRefs(sf, narrowingNames)) {
        if (!found[name].includes(rel)) found[name].push(rel);
      }
    }

    for (const [fn, expected] of Object.entries(NARROWING_CONSUMERS)) {
      expect(found[fn].sort(), `consumers of ${fn}`).toEqual([...expected].sort());
    }
    // POSITIVE CONTROL: the scan must have found something, or two empty sets would match
    // two empty expectations.
    expect(Object.values(found).flat().length, 'the narrowing scan found nothing').toBe(2);
  });

  it('POSITIVE CONTROL: the export scan sees exports written in every shape', () => {
    // 🔴 Without this the classification assertion is satisfiable by an export scan that
    // sees nothing: an empty set compared against an empty classification. Each shape below
    // is one the helper module could legitimately use.
    const shapes: [string, string, string[]][] = [
      ['function declaration', 'export function a() {}', ['a']],
      ['const arrow', 'export const b = () => 1;', ['b']],
      ['const value', 'export const c = 3;', ['c']],
      ['multi declarator', 'export const d = 1, e = 2;', ['d', 'e']],
      ['class', 'export class F {}', ['F']],
      ['named re-export of locals', 'const g = 1;\nexport { g };', ['g']],
      ['async function', 'export async function h() {}', ['h']],
      // 🔴 The four default-export shapes, every one of which the scan missed. The first
      // was planted as a live third caller and left every test green.
      ['default expression', 'const i = 1;\nexport default i;', ['default']],
      ['default arrow', 'export default () => 1;', ['default']],
      ['default anonymous function', 'export default function () {}', ['default']],
      ['default anonymous class', 'export default class {};', ['default']],
      ['default NAMED function', 'export default function j() {}', ['j']],
      // 🔴 The destructured shapes, measured as a LIVE escape before this: a relay caller
      // exported this way, with a consumer importing only that name, left every test green.
      ['object destructure', 'const api = { go: 1 };\nexport const { go } = api;', ['go']],
      [
        'object destructure, renamed',
        'const api = { go: 1 };\nexport const { go: away } = api;',
        ['away'],
      ],
      ['array destructure', 'const arr = [1, 2];\nexport const [k, l] = arr;', ['k', 'l']],
      ['array destructure with a hole', 'const arr = [1, 2];\nexport const [, m] = arr;', ['m']],
      [
        'nested destructure',
        'const api = { a: { b: 1 } };\nexport const {\n  a: { b },\n} = api;',
        ['b'],
      ],
    ];
    for (const [name, source, expected] of shapes) {
      expect(exportedValueNames(parse('src/x.ts', source)).sort(), `shape "${name}"`).toEqual(
        expected.sort()
      );
    }
    // And a TYPE export is not a value — including it would make the map a list of names
    // with no bearing on whether anything can reach the relay.
    expect(exportedValueNames(parse('src/x.ts', 'export type T = string;'))).toEqual([]);
    // The real module must produce at least TWO exports, or the assertion above is
    // vacuous. Two rather than one because the classification test it feeds compares a
    // partition, and a one-element partition is satisfied by either half being empty.
    expect(helperExportNames.length, 'the helper module must expose exports').toBeGreaterThan(1);
  });

  it('POSITIVE CONTROL: the sweep reaches real files and the parse finds real references', () => {
    // 🔴 A scan can walk thousands of files and match nothing — which returns an empty set,
    // and an empty set compared against an empty ledger is the reassuring zero this whole
    // change exists to stop believing.
    expect(candidates).toEqual(expect.arrayContaining(CALLER_LEDGER));
    expect(referencing.length, 'the parse must actually find references').toBeGreaterThan(1);
    expect(helperPathRefs, 'the helper module must have been parsed at all').toBeGreaterThan(-1);
  });

  it('POSITIVE CONTROL: the prefilter admits a file on each hint, from a FIXED corpus', () => {
    // 🔴 THE CONTROL THAT WAS A TAUTOLOGY, and this is the form that is not. The previous
    // version asserted `isCandidateText` on a fixture built by INTERPOLATING the hint under
    // test, so `includes(hint)` was true for any content and the assertion could never
    // fail; it also iterated the SURVIVING list, so deleting an entry removed an iteration
    // rather than failing one. Measured: deleting the helper-name hint left every test
    // green EVEN WITH a live third caller planted.
    //
    // These fixtures are hard-coded and name no constant, so they go red if a hint is
    // deleted, renamed or garbled — and each is written the way a real third caller would
    // be, not as a bare token.
    // 🔴 ONE FIXTURE PER ENTRY POINT. A single fixture proves only that SOME hint works —
    // measured: with only the `postImageUploadRelay` fixture here, deleting the
    // `relayImageFallback` hint left all seven tests green, and that hint is the only way in
    // for a caller written the way the REAL multipart caller is written. This is the same
    // shape as the per-hint failure round 4 fixed, reappearing the moment a second entry
    // point was added — so the loop is over the entry points, with a fixture each.
    const entryPointFixtures: Record<string, string> = {
      postImageUploadRelay: "import { postImageUploadRelay } from '~/utils/upload-settlement';",
      relayImageFallback: "import { relayImageFallback } from '~/utils/upload-settlement';",
    };
    for (const entry of HELPER_EXPORTS) {
      const fixture = entryPointFixtures[entry];
      expect(fixture, `no prefilter fixture for entry point "${entry}"`).toBeDefined();
      expect(
        isCandidateText(fixture),
        `a module importing "${entry}" must be admitted — for a caller that names no path ` +
          `this hint is the only way in`
      ).toBe(true);
    }
    expect(
      isCandidateText("await fetch('/api/v1/image-upload/relay', { method: 'POST' });"),
      'a module building its own request must be admitted'
    ).toBe(true);
    // NEGATIVE control: the predicate must be able to say no, or a prefilter that admitted
    // everything would satisfy both assertions above.
    expect(isCandidateText('export const unrelated = 1;')).toBe(false);
  });

  it('POSITIVE CONTROL: a reference is seen in every shape a caller could use', () => {
    // 🔴 The shapes that defeated the three CALL-recognising versions of this guard, kept
    // as a control on the reference reading — every one of them writes the identifier or
    // the path, which is why this version does not have to understand any of them.
    const shapes: [string, string][] = [
      [
        'plain call',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';\nexport const go = (f: File) => postImageUploadRelay(f, {} as never);`,
      ],
      [
        'alias import',
        `import { postImageUploadRelay as post } from '~/utils/upload-settlement';\nexport const go = (f: File) => post(f, {} as never);`,
      ],
      [
        'namespace call',
        `import * as settlement from '~/utils/upload-settlement';\nexport const go = (f: File) => settlement.postImageUploadRelay(f, {} as never);`,
      ],
      [
        'namespace .call',
        `import * as settlement from '~/utils/upload-settlement';\nexport const go = (f: File) => settlement.postImageUploadRelay.call(null, f, {} as never);`,
      ],
      [
        'comma sequence',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';\nexport const go = (f: File) => (0, postImageUploadRelay)(f, {} as never);`,
      ],
      [
        'Reflect.apply',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';\nexport const go = (f: File) => Reflect.apply(postImageUploadRelay, null, [f, {}]);`,
      ],
      [
        'object property',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';\nconst api = { post: postImageUploadRelay };\nexport const go = (f: File) => api.post(f, {} as never);`,
      ],
      [
        'dynamic import destructure',
        `export const go = async (f: File) => {\n  const { postImageUploadRelay: p } = await import('~/utils/upload-settlement');\n  return p(f, {} as never);\n};`,
      ],
      ['re-export barrel', `export { postImageUploadRelay } from '~/utils/upload-settlement';`],
      // 🔴 THE THREE STRING-SPELLED SHAPES, each a measured or one-character-adjacent
      // escape. The first was live: it compiled, ran, and left 847 tests green.
      [
        'namespace element access, string literal',
        `import * as s from '~/utils/upload-settlement';\nexport const go = (f: File) => s['postImageUploadRelay'](f, {} as never);`,
      ],
      [
        'dynamic import, string element access',
        `export const go = async (f: File) => (await import('~/utils/upload-settlement'))['postImageUploadRelay'](f, {} as never);`,
      ],
      [
        'string held in a const, then computed access',
        `import * as s from '~/utils/upload-settlement';\nconst k = 'postImageUploadRelay';\nexport const go = (f: File) => (s as never as Record<string, (a: File, b: never) => unknown>)[k](f, {} as never);`,
      ],
      [
        'raw fetch, single quotes',
        `export const go = (b: BodyInit) => fetch('/api/v1/image-upload/relay', { body: b });`,
      ],
      [
        'raw fetch, double quotes',
        `export const go = (b: BodyInit) => fetch("/api/v1/image-upload/relay", { body: b });`,
      ],
      [
        'raw fetch, interpolated base',
        'declare const B: string;\nexport const go = (b: BodyInit) => fetch(`${B}/image-upload/relay`, { body: b });',
      ],
    ];

    for (const [name, source] of shapes) {
      const sf = parse('src/x.ts', source);
      const { helper, pathLiterals } = referencesRelay(sf);
      expect(helper || pathLiterals > 0, `shape "${name}" must be seen as a reference`).toBe(true);
      // And the prefilter must admit it too — a shape the parse can see but the prefilter
      // skips is still invisible in a real sweep.
      expect(isCandidateText(source), `shape "${name}" must survive the prefilter`).toBe(true);
    }
  });

  it('the sweep covers every root that holds production TypeScript', () => {
    // 🔴 A ROOT NOBODY ASSERTS IS A ROOT SOMEONE CAN DELETE, and deleting one is SILENT in
    // exactly the way that matters: the sweep simply stops walking a directory, every test
    // here stays green, and a caller living there becomes invisible. Measured — removing
    // `event-engine-common` from `ROOTS` while a live third caller sat inside it left all
    // 27 tests passing. That is the same failure as the escapes above, reached by
    // subtraction rather than by a clever call shape, and the only guard that can see it is
    // one that names the roots.
    //
    // Hard-coded, deliberately, for the same reason the extension loop below is: iterating
    // `ROOTS` to check `ROOTS` shrinks with it and proves nothing.
    for (const root of ['src', 'apps', 'packages', 'scripts', 'event-engine-common']) {
      expect(ROOTS, `the sweep must still walk "${root}"`).toContain(root);
    }
    // 🔴 AND THE ROOTS MUST ACTUALLY YIELD FILES, or the list above is a claim about a
    // string array rather than about the sweep. A root can be present and contribute
    // nothing — an unpopulated submodule is the live example — and a ledger built on a
    // root that silently scans zero files is the reassuring-zero shape this file exists to
    // refuse. So each root is required to produce at least one file it would parse.
    //
    // ⚠ `event-engine-common` is EXEMPT from that second half, and the exemption is the
    // honest part: it is a git submodule, so a fresh checkout that has not run
    // `submodule update` legitimately has nothing there. Requiring files would make this
    // test fail on a correct checkout. The consequence is stated rather than hidden — in
    // such a checkout the submodule contributes no coverage, so CI must populate it for
    // this root to be worth anything.
    const OPTIONAL_ROOTS = new Set(['event-engine-common']);
    for (const root of ROOTS) {
      if (OPTIONAL_ROOTS.has(root)) continue;
      const files = walkFiles(path.join(REPO_ROOT, root), []);
      expect(files.length, `root "${root}" must yield files for the sweep`).toBeGreaterThan(0);
    }
  });

  it('POSITIVE CONTROL: a colocated spec is excluded in EVERY extension the walker admits', () => {
    // 🔴 THE CONTROL FOR A LATENT FIX, and without it the fix is unverifiable. The walker
    // was widened to `.js`/`.mjs`/`.svelte` while the spec regex still said `tsx?$`, so a
    // colocated `*.test.js` naming the helper would be reported as a production caller — a
    // false red naming a caller that does not exist. There is no such file in the tree
    // today, so nothing in the sweep can see the regex being wrong: reverting it leaves
    // every test green. Driving `isProductionFile` directly is what makes it observable.
    //
    // The pairing is the point — the same basename must be excluded as a spec and included
    // as production, or an over-broad regex would satisfy the first half by excluding
    // everything.
    //
    // 🔴 THE LIST HERE IS HARD-CODED, NOT `WALKED_EXTENSIONS`. Both regexes are derived
    // from that constant now, so iterating it would shrink the walker, the spec filter and
    // this control together and prove nothing — the "control that interpolates the thing
    // under test" trap this file names elsewhere. Writing the extensions out means DROPPING
    // one from `WALKED_EXTENSIONS` fails here. The `toContain` is what makes that failure
    // say which one, rather than showing up as a production file that is suddenly not one.
    // (`.svelte` was previously absent from this loop while the walker admitted it, so
    // `thing.test.svelte` counted as production — narrower body than the title claimed.)
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs', 'svelte']) {
      expect(WALKED_EXTENSIONS, `the walker must still admit *.${ext}`).toContain(ext);
      expect(isProductionFile(`src/utils/thing.test.${ext}`), `*.test.${ext}`).toBe(false);
      expect(isProductionFile(`src/utils/thing.spec.${ext}`), `*.spec.${ext}`).toBe(false);
      expect(isProductionFile(`src/utils/thing.${ext}`), `production *.${ext}`).toBe(true);
    }
    // And the directory form, which is this repo's dominant convention.
    expect(isProductionFile('src/utils/__tests__/thing.ts')).toBe(false);
  });

  it('POSITIVE CONTROL: prose and type positions are NOT references', () => {
    // The parse earning its keep over a text scan. Several production modules document the
    // route in a comment; a text-only guard would report every one of them as a caller.
    const inert: [string, string][] = [
      ['line comment', `// see ${RELAY_PATH}\nexport const n = 1;`],
      [
        'block comment',
        `/** calls \`${HELPER_EXPORTS[0]}\` at \`${RELAY_PATH}\` */\nexport const n = 1;`,
      ],
      ['type alias', `export type RelayRoute = '${RELAY_PATH}';`],
      [
        'import specifier only',
        `import handler from '~/pages/api/v1/image-upload/relay';\nexport const n = handler;`,
      ],
      [
        'type-only import',
        `import type { postImageUploadRelay } from '~/utils/upload-settlement';\nexport type Y = typeof postImageUploadRelay;`,
      ],
    ];
    for (const [name, source] of inert) {
      const sf = parse('src/x.ts', source);
      const { helper, pathLiterals } = referencesRelay(sf);
      expect(helper || pathLiterals > 0, `"${name}" must NOT read as a reference`).toBe(false);
    }

    // ⚠ And the limit, pinned rather than described: a path split so the tail never appears
    // as one literal is NOT seen. If someone closes this, the test tells them to update the
    // limits list above.
    const split = parse(
      'src/x.ts',
      `export const go = (b: BodyInit) => fetch('/api/v1/image-upload' + '/relay', { body: b });`
    );
    const splitRefs = referencesRelay(split);
    expect(
      splitRefs.helper || splitRefs.pathLiterals > 0,
      'known limit — see the limits list above'
    ).toBe(false);
  });
});
