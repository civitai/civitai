import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { IMAGE_UPLOAD_RELAY_PRODUCERS } from '~/utils/image-upload-relay-producer';

/**
 * THE RELAY CALLER LEDGER — the set of code paths that can reach
 * `/api/v1/image-upload/relay`, and the producer label each one declares.
 *
 * WHY THIS FILE EXISTS. `civitai_image_upload_relay_total` gained a `producer` label so the
 * relay's two callers could be told apart: before it, the counter's non-zero `success` was
 * attributable entirely to the older single-PUT path, and grading the newer multipart path
 * on it returned a confident false positive. Every other guard around that change bounds
 * ONE component — the sanitiser bounds a value, the metrics module bounds a series, each
 * hook sends its own header. None of them can see a THIRD caller appear, and a third caller
 * is exactly how the defect comes back: `postImageUploadRelay`'s `producer` parameter is
 * typed to the label union, so a new call site is FORCED to reuse `single_put` or
 * `multipart` to compile, and its traffic is then added to a row someone is already
 * grading. That is worse than the `unknown` pooling it looks like, because the corrupted
 * row is the one carrying a decision.
 *
 * So this asserts the SET, and fails when it GROWS or SHRINKS.
 *
 * 🔴 A RELATIONSHIP, NOT A SPELLING — and this file is the second attempt, because the
 * first was the spelled kind and was measured fail-open. That draft required the literal
 * shape `postImageUploadRelay(<identifier>, {` plus a single-quoted path, and a round-2
 * review found SEVEN realistic third-caller shapes it could not see —
 * `postImageUploadRelay(opts.file, …)`, `postImageUploadRelay(files[0], …)`, an
 * `import { postImageUploadRelay as post }` alias, an options object held in a variable, a
 * double-quoted path, a template-literal path, and a call whose opts object contained a
 * nested brace. Each of them adds a live caller and left the guard green. The mutation that
 * "proved" the guard worked had happened to use the one shape it caught — the mutation
 * sweep's own blind spot, in its textbook form.
 *
 * `src/server/services/__tests__/no-unledgered-settle-caller.test.ts` is the repo's worked
 * example of the structural form, and its docstring is explicit that this repo has already
 * closed six fail-open SPELLED guards. This file follows its TECHNIQUE (parse, walk
 * `ts.CallExpression`, close the binding set under aliasing) at a much smaller scale; it is
 * NOT claiming that file's depth. So:
 *
 *   - CALLS are `ts.CallExpression` nodes from a real parse. The identifier written in a
 *     comment, in a string, or in a type position is structurally not a call and cannot
 *     satisfy anything — which is also why this file needs no comment-stripping pass.
 *   - The callee is matched against whatever LOCAL NAME the module bound, closed under
 *     `import { x as y }`, namespace imports, dynamic-import destructures and local
 *     rebinding.
 *   - A raw request to the path is found as a string/template LITERAL NODE, so all three
 *     quote styles are covered and a path written in prose is not.
 *
 * 🔴 WHAT IS STILL OUT OF REACH — stated because it is open, not softened:
 *   - The PREFILTER is a spelling. Only files whose raw text mentions the export name or
 *     the path segment are parsed, so a module reached through a computed specifier and a
 *     computed property access would be skipped. The defining module and every ledgered
 *     file are parsed unconditionally, so the prefilter cannot quietly drop those.
 *   - Rebinding through anything other than a variable declaration — a later assignment,
 *     a parameter, a class field, an array destructure — is not followed. `.call`,
 *     `.apply`, `.bind`, `?:`, `??`, `||`, an object PROPERTY and a namespace destructure
 *     ARE followed; they were not until a round-3 audit produced them as live escapes,
 *     which is the same list the precedent closed after its own round-2 audit.
 *   - A RE-EXPORT BARREL. A module that does `export { postImageUploadRelay } from
 *     '…upload-settlement'`, imported from under a different path, is not resolved — the
 *     importer's specifier does not contain `upload-settlement`, so the binding is not
 *     learned. Measured as a live escape; recorded rather than closed, because resolving
 *     re-exports means following the module graph and that is the point at which this
 *     should become the precedent's machinery rather than a smaller copy of it.
 *   - A path split ACROSS the matched tail by concatenation
 *     (`'/api/v1/image-upload' + '/relay'`). Pinned by a case in the raw-path control, so
 *     closing it makes that case fail and this line gets updated.
 *   - The producer literal is read only when the opts argument is an object literal with a
 *     string-literal `producer`. Anything else records `<non-literal>` and turns the ledger
 *     RED rather than passing quietly: the failure direction is deliberate.
 *   - Reachability is not evaluated. A call behind a flag counts as a call site; this
 *     answers "who CAN reach the relay", not "who does on every path".
 *
 * NOT REGRESSION COVERAGE — AN INVARIANT GUARD, LABELLED AS ONE. Nothing at the base commit
 * violates it; the set is already exactly two, which is the fact the producer label rests
 * on. The controls at the bottom are what make it a guard that can go red.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * Roots that can hold production TypeScript reaching the relay.
 *
 * `apps` and `packages` are swept as well as `src` for the same reason the settle ledger
 * widened past `src`: the relay is an ordinary same-origin POST, so a workspace app could
 * make one, and a caller nobody scans is a caller nobody ledgers. Nothing outside `src`
 * reaches it today, so this widened the reach without moving the ledger.
 */
const ROOTS = ['src', 'apps', 'packages'];

const HELPER_MODULE = 'src/utils/upload-settlement.ts';
const HELPER_EXPORT = 'postImageUploadRelay';
const RELAY_PATH = '/api/v1/image-upload/relay';
/** The tail, so an interpolated base still matches. See `countPathLiteralsInCode`. */
const RELAY_PATH_TAIL = '/image-upload/relay';
/** The prefilter spellings. See the limits above — this is the one spelling that remains. */
const TEXT_HINTS = [HELPER_EXPORT, 'image-upload/relay'];

/**
 * Does this file's raw text earn a parse?
 *
 * Extracted so its control can drive THIS function rather than a copy of the expression.
 * A prefilter that admits nothing is how a third caller goes unseen — an unknown file has
 * no other way into the scan — and the previous control could not observe it, because
 * every non-ledgered file in the tree happens to be admitted by the path hint and the
 * ledgered files bypass the prefilter entirely.
 */
function isCandidateText(text: string): boolean {
  return TEXT_HINTS.some((hint) => text.includes(hint));
}

type Site = { file: string; producer: string };

/**
 * THE LEDGER. Compared in BOTH directions: a third caller fails it, and so does losing one.
 *
 * `producer` is carried because the set of FILES is not the claim — two callers sharing one
 * label is the failure the type system cannot express, and it is the one that silently
 * re-creates the attribution defect this whole change removes.
 */
const CALLER_LEDGER: Site[] = [
  { file: 'src/hooks/useCFImageUpload.tsx', producer: 'single_put' },
  { file: HELPER_MODULE, producer: 'multipart' },
];

function key(site: Site): string {
  return `${site.file} :: producer=${site.producer}`;
}

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
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist')
        continue;
      walkFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
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
  return !rel.includes('__tests__') && !/\.(test|spec)\.tsx?$/.test(rel);
}

/** Local names in this module that hold the helper function, its namespace, or a property. */
function bindingsOf(
  sf: ts.SourceFile,
  rel: string
): { direct: Set<string>; ns: Set<string>; properties: Set<string> } {
  const direct = new Set<string>();
  const ns = new Set<string>();
  const properties = new Set<string>();
  // The defining module binds the export under its own declared name.
  if (rel === HELPER_MODULE) direct.add(HELPER_EXPORT);

  const isHelperModuleSpec = (spec: string) => spec.includes('upload-settlement');

  const visit = (node: ts.Node): void => {
    // `import { postImageUploadRelay as post } from '~/utils/upload-settlement'`
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isHelperModuleSpec(node.moduleSpecifier.text) &&
      node.importClause
    ) {
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) ns.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if ((el.propertyName?.text ?? el.name.text) === HELPER_EXPORT) direct.add(el.name.text);
        }
      }
    }
    // `const { postImageUploadRelay: p } = await import('~/utils/upload-settlement')`
    // and `const post = postImageUploadRelay` — one pass is enough for the shapes seen
    // here; the limits block says rebinding beyond a VariableDeclaration is not followed.
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      const fromHelperModule =
        ts.isCallExpression(init) &&
        init.expression.kind === ts.SyntaxKind.ImportKeyword &&
        init.arguments.length > 0 &&
        ts.isStringLiteralLike(init.arguments[0]) &&
        isHelperModuleSpec(init.arguments[0].text);
      if (fromHelperModule && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const propName = el.propertyName ?? el.name;
          if (
            ts.isIdentifier(propName) &&
            propName.text === HELPER_EXPORT &&
            ts.isIdentifier(el.name)
          )
            direct.add(el.name.text);
        }
      }
      if (fromHelperModule && ts.isIdentifier(node.name)) ns.add(node.name.text);
      // `const post = postImageUploadRelay`, and `const post = x.bind(null)` where `x` is
      // already a binding. `.bind` is here because the precedent's own round-2 audit found
      // a `.bind` alias and a `.call` as LIVE third callers with every assertion green.
      const unwrapped = unwrap(init);
      if (ts.isIdentifier(node.name) && choiceIdentifiers(init).some((id) => direct.has(id.text)))
        direct.add(node.name.text);
      if (
        ts.isCallExpression(unwrapped) &&
        ts.isPropertyAccessExpression(unwrapped.expression) &&
        unwrapped.expression.name.text === 'bind' &&
        ts.isIdentifier(unwrapped.expression.expression) &&
        direct.has(unwrapped.expression.expression.text) &&
        ts.isIdentifier(node.name)
      )
        direct.add(node.name.text);
      // `const { postImageUploadRelay: p } = settlement` — a destructure off a namespace
      // object rather than off a dynamic import.
      if (ts.isIdentifier(init) && ns.has(init.text) && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const propName = el.propertyName ?? el.name;
          if (
            ts.isIdentifier(propName) &&
            propName.text === HELPER_EXPORT &&
            ts.isIdentifier(el.name)
          )
            direct.add(el.name.text);
        }
      }
    }
    // `const api = { post: postImageUploadRelay }` — the binding survives into a property.
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.initializer) &&
      direct.has(node.initializer.text) &&
      ts.isIdentifier(node.name)
    ) {
      properties.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  // A fixed point, because a binding can be learned AFTER the site that re-binds it is
  // visited — `const b = a` above `const a = postImageUploadRelay` is legal at module
  // scope in a function body. Two passes settle every shape modelled here; a third is
  // cheap insurance rather than a claim about depth.
  for (let pass = 0; pass < 3; pass++) visit(sf);
  return { direct, ns, properties };
}

/**
 * Peel the wrappers that do not change WHICH function is being referred to.
 *
 * `(f)`, `f as T`, `f!`, `(0, f)` and a `?:`/`??`/`||` choice between a binding and
 * something else all resolve to the binding for our purposes — the precedent covers the
 * same set, and it records that `??`/`||` were a live fail-open before it did.
 */
function unwrap(node: ts.Node): ts.Node {
  let n = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) {
      n = n.expression;
      continue;
    }
    return n;
  }
}

/**
 * Every identifier a choice expression could resolve to.
 *
 * 🔴 BOTH BRANCHES, and that is not a detail. An earlier version took the left branch when
 * it was an identifier and only then looked right, so `const post = maybe ?? helper` lost
 * the binding entirely — the helper sat on the side the walk never reached. The precedent
 * records `??`/`||` as a live fail-open it had to close for the same reason. `?:`, `??`,
 * `||` and `&&` all reach here.
 */
function choiceIdentifiers(node: ts.Node): ts.Identifier[] {
  const n = unwrap(node);
  if (ts.isConditionalExpression(n))
    return [...choiceIdentifiers(n.whenTrue), ...choiceIdentifiers(n.whenFalse)];
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return [...choiceIdentifiers(n.left), ...choiceIdentifiers(n.right)];
  }
  return ts.isIdentifier(n) ? [n] : [];
}

type Bindings = { direct: Set<string>; ns: Set<string>; properties: Set<string> };

/**
 * Is this call expression a call of the helper, under any local binding?
 *
 * ⚠ Returns the ARGUMENT OFFSET as well, because `.call`/`.apply` shift the real arguments
 * along and a producer read at the wrong offset would be a silent wrong answer rather than
 * a miss.
 */
function helperCallOffset(call: ts.CallExpression, b: Bindings): number | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    if (b.direct.has(callee.text) || b.properties.has(callee.text)) return 0;
    return null;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const objectNode = unwrap(callee.expression);
    // `settlement.postImageUploadRelay(…)` — a namespace call.
    if (ts.isIdentifier(objectNode) && b.ns.has(objectNode.text)) {
      return callee.name.text === HELPER_EXPORT ? 0 : null;
    }
    // `api.post(…)` — the helper held in an object property.
    if (b.properties.has(callee.name.text)) return 0;
    // `post.call(thisArg, file, opts)` / `post.apply(thisArg, [file, opts])`.
    if (
      (callee.name.text === 'call' || callee.name.text === 'apply') &&
      ts.isIdentifier(objectNode) &&
      (b.direct.has(objectNode.text) || b.properties.has(objectNode.text))
    ) {
      // `.apply` takes an array, so the opts are not a positional argument at all; report
      // the offset that makes `producerOf` return a marker rather than a wrong label.
      return callee.name.text === 'call' ? 1 : 99;
    }
  }
  return null;
}

/** The `producer:` literal a call site declares, or a marker that turns the ledger red. */
function producerOf(call: ts.CallExpression, offset = 0): string {
  const opts = call.arguments[1 + offset];
  if (!opts || !ts.isObjectLiteralExpression(opts)) return '<non-literal-opts>';
  for (const prop of opts.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (name !== 'producer') continue;
    return ts.isStringLiteralLike(prop.initializer)
      ? prop.initializer.text
      : '<non-literal-producer>';
  }
  return '<no-producer>';
}

/**
 * How many times this module names the relay path as a literal in CODE.
 *
 * A COUNT, not a boolean, because the helper module legitimately holds exactly one and the
 * ledger has to be able to say "one is expected, two is a new raw caller" rather than
 * exempting the file wholesale.
 *
 * ⚠ Matches the path TAIL (`/image-upload/relay`), not the full path, so an interpolated
 * base — `` fetch(`${BASE}/image-upload/relay`) `` — still registers. A path split ACROSS
 * the tail by concatenation (`'/api/v1/image-upload' + '/relay'`) is not matched; it is in
 * the limits list above.
 */
function countPathLiteralsInCode(sf: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      node.getText(sf).includes(RELAY_PATH_TAIL)
    ) {
      count += 1;
      // Do not descend into a template's own spans — the tail is counted once per literal.
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

function scan(): { sites: Site[]; candidates: string[] } {
  const files: string[] = [];
  for (const root of ROOTS) walkFiles(path.join(REPO_ROOT, root), files);

  const sites: Site[] = [];
  const candidates: string[] = [];
  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (!isProductionFile(rel)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const ledgered = CALLER_LEDGER.some((s) => s.file === rel);
    // Ledgered files are parsed unconditionally, so the prefilter can never drop one.
    if (!ledgered && !isCandidateText(text)) continue;
    candidates.push(rel);
    const sf = parse(rel, text);
    const bindings = bindingsOf(sf, rel);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const offset = helperCallOffset(node, bindings);
        if (offset !== null) sites.push({ file: rel, producer: producerOf(node, offset) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    // 🔴 UNCONDITIONAL, AND COUNTED. A module that builds its own request to the path is a
    // caller too — that is precisely what the shared helper exists to prevent, and
    // `upload-settlement.ts` unexports the path constant to make it hard.
    //
    // ⚠ This used to be gated on `!calls.length` and to exempt the helper module outright,
    // which made a raw `fetch` INVISIBLE inside either of the two ledgered files — the two
    // likeliest places to write one. Measured: appending a raw `fetch` to
    // `useCFImageUpload.tsx` or to `upload-settlement.ts` left all tests green. The helper
    // module is now allowed exactly the ONE literal it owns, and a second turns the ledger
    // red like any other raw site.
    const allowance = rel === HELPER_MODULE ? 1 : 0;
    const rawSites = countPathLiteralsInCode(sf) - allowance;
    for (let i = 0; i < rawSites; i++) sites.push({ file: rel, producer: '<raw-request>' });
  }
  return { sites, candidates };
}

describe('the relay caller ledger', () => {
  const { sites, candidates } = scan();

  it('finds EVERY relay caller in the ledger, and no caller outside it', () => {
    expect(sites.map(key).sort()).toEqual(CALLER_LEDGER.map(key).sort());
  });

  it('gives every caller a producer label of its own', () => {
    // 🔴 The failure the type system cannot express. `postImageUploadRelay`'s parameter is
    // typed to the label union, so a third caller COMPILES by reusing an existing label —
    // and its traffic then lands in a row someone is already grading, which is the exact
    // false positive the producer label was added to remove.
    const producers = sites.map((s) => s.producer);
    expect(new Set(producers).size, 'two callers share one producer label').toBe(producers.length);
    for (const p of producers) {
      expect(
        (IMAGE_UPLOAD_RELAY_PRODUCERS as readonly string[]).includes(p),
        `producer=${p} is not a declared label`
      ).toBe(true);
    }
    // `unknown` is the server's bucket for a caller that said nothing. A client DECLARING
    // it would be opting out of attribution while looking attributed.
    expect(producers).not.toContain('unknown');
  });

  it('POSITIVE CONTROL: the sweep reaches real files and the parse finds real call sites', () => {
    // 🔴 Two separate claims, because the first does not imply the second and an earlier
    // draft of this guard only made the first. A scan can walk thousands of files and still
    // match nothing — which returns an empty caller set, and an empty set compared against
    // an empty ledger is the reassuring zero this whole change exists to stop believing.
    expect(candidates).toEqual(expect.arrayContaining(CALLER_LEDGER.map((s) => s.file)));
    expect(sites.length, 'the AST walk must actually find call sites').toBeGreaterThan(1);

    // 🔴 THE PREFILTER'S OWN CONTROL, and the reason this assertion is not simply
    // `parsed > 1`. Ledgered files are parsed UNCONDITIONALLY, so every count that
    // includes them is satisfied whether or not the prefilter works at all — measured:
    // replacing `TEXT_HINTS` with a token that appears nowhere left all 125 tests GREEN.
    // A prefilter matching nothing is precisely how a third caller goes unseen, since an
    // unknown file has no other way in. So the claim has to be that the prefilter admits a
    // file it was NOT told about.
    const ledgeredFiles = new Set(CALLER_LEDGER.map((s) => s.file));
    const admittedOnItsOwn = candidates.filter((c) => !ledgeredFiles.has(c));
    expect(
      admittedOnItsOwn.length,
      'the prefilter must admit at least one file the ledger does not name'
    ).toBeGreaterThan(0);

    // Named, not just counted: the route mentions its own path, so its admission proves
    // the hints reach real code rather than an empty set.
    expect(admittedOnItsOwn).toContain('src/pages/api/v1/image-upload/relay.ts');
  });

  it('POSITIVE CONTROL: EACH prefilter hint can admit a file on its own', () => {
    // 🔴 PER HINT, NOT IN AGGREGATE — the second correction this control needed, and the
    // reason the aggregate form was not enough. Every non-ledgered file in the tree happens
    // to be admitted by the PATH hint, and the ledgered files bypass the prefilter
    // entirely. Measured on the aggregate form: deleting the path hint turned it red, and
    // deleting the HELPER-NAME hint left everything GREEN — yet the helper name is the sole
    // entry route for a third caller that imports the helper, which is the shape the type
    // system forces. So a hint with no file of its own is a hint nothing can observe.
    //
    // Driven on SYNTHETIC text rather than on the tree, because whether a hint has a
    // distinguishing real file is an accident of what exists today, and this claim is about
    // the predicate. It calls `isCandidateText` itself, not a copy of the expression.
    expect(isCandidateText('nothing to see here'), 'the predicate must be able to say NO').toBe(
      false
    );
    for (const hint of TEXT_HINTS) {
      expect(
        isCandidateText(`const x = "${hint}";`),
        `hint "${hint}" admits nothing, so a caller reachable only through it is invisible`
      ).toBe(true);
    }
    // And the two hints are not the same hint wearing two spellings: each must admit text
    // the other rejects, or one of them is dead weight that no mutation could reveal.
    for (const hint of TEXT_HINTS) {
      const others = TEXT_HINTS.filter((h) => h !== hint);
      expect(
        others.some((o) => `const x = "${hint}";`.includes(o)),
        `hint "${hint}" is subsumed by another hint`
      ).toBe(false);
    }
  });

  it('POSITIVE CONTROL: the call matcher sees a caller written in a shape unlike the real ones', () => {
    // 🔴 The control the first draft of this guard lacked, and the reason it was fail-open:
    // it was only ever exercised against the two call shapes already in the tree, so every
    // shape it could NOT see went unnoticed. This parses synthetic modules covering the
    // shapes that defeated it — and the further ones a later round found — and asserts
    // each is seen.
    //
    // ⚠ SCOPE, stated because it is the half this control CANNOT cover: it drives the real
    // `parse`/`bindingsOf`/`helperCallOffset`/`producerOf`, but it re-walks the AST itself
    // rather than calling `scan()`. So it is a control over the MATCHER, never over the
    // SCANNER — the prefilter, the file walk, the production-file filter and the raw-path
    // counting are covered by the other three cases, not by this one. Two of the three
    // defects found in this file lived on the scanner side.
    const shapes: [string, string][] = [
      [
        'alias import',
        `import { postImageUploadRelay as post } from '~/utils/upload-settlement';
         export const go = (f: File, s: AbortSignal) => post(f, { signal: s, producer: 'multipart' });`,
      ],
      [
        'namespace import',
        `import * as settlement from '~/utils/upload-settlement';
         export const go = (f: File, s: AbortSignal) =>
           settlement.postImageUploadRelay(f, { signal: s, producer: 'multipart' });`,
      ],
      [
        'member-expression argument',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';
         export const go = (o: { file: File }, s: AbortSignal) =>
           postImageUploadRelay(o.file, { signal: s, producer: 'multipart' });`,
      ],
      [
        'indexed argument',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';
         export const go = (files: File[], s: AbortSignal) =>
           postImageUploadRelay(files[0], { signal: s, producer: 'multipart' });`,
      ],
      [
        'local rebinding',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';
         const post = postImageUploadRelay;
         export const go = (f: File, s: AbortSignal) => post(f, { signal: s, producer: 'multipart' });`,
      ],
      [
        'dynamic import destructure',
        `export const go = async (f: File, s: AbortSignal) => {
           const { postImageUploadRelay: p } = await import('~/utils/upload-settlement');
           return p(f, { signal: s, producer: 'multipart' });
         };`,
      ],
      [
        'nested brace in the opts object',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';
         export const go = (f: File, s: AbortSignal) =>
           postImageUploadRelay(f, { signal: s, producer: 'multipart', meta: { a: 1 } });`,
      ],
      // The precedent's own round-2 audit found `.call` and a `.bind` alias as LIVE third
      // callers with every assertion green. They are covered here for the same reason.
      [
        '.call with an explicit thisArg',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';
         export const go = (f: File, s: AbortSignal) =>
           postImageUploadRelay.call(null, f, { signal: s, producer: 'multipart' });`,
      ],
      [
        '.bind alias',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';
         const post = postImageUploadRelay.bind(null);
         export const go = (f: File, s: AbortSignal) => post(f, { signal: s, producer: 'multipart' });`,
      ],
      [
        'held in an object property',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';
         const api = { post: postImageUploadRelay };
         export const go = (f: File, s: AbortSignal) =>
           api.post(f, { signal: s, producer: 'multipart' });`,
      ],
      [
        'chosen by a ternary',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';
         declare const other: typeof postImageUploadRelay;
         const post = cond ? postImageUploadRelay : other;
         export const go = (f: File, s: AbortSignal) => post(f, { signal: s, producer: 'multipart' });
         declare const cond: boolean;`,
      ],
      [
        'nullish-coalesced',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';
         declare const maybe: typeof postImageUploadRelay | undefined;
         const post = maybe ?? postImageUploadRelay;
         export const go = (f: File, s: AbortSignal) => post(f, { signal: s, producer: 'multipart' });`,
      ],
      [
        'destructured off a namespace object',
        `import * as settlement from '~/utils/upload-settlement';
         const { postImageUploadRelay: p } = settlement;
         export const go = (f: File, s: AbortSignal) => p(f, { signal: s, producer: 'multipart' });`,
      ],
      [
        'optional call',
        `import { postImageUploadRelay } from '~/utils/upload-settlement';
         export const go = (f: File, s: AbortSignal) =>
           postImageUploadRelay?.(f, { signal: s, producer: 'multipart' });`,
      ],
    ];

    for (const [name, source] of shapes) {
      const rel = 'src/hooks/__synthetic__.ts';
      const sf = parse(rel, source);
      const bindings = bindingsOf(sf, rel);
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const offset = helperCallOffset(node, bindings);
          if (offset !== null) found.push(producerOf(node, offset));
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      expect(found, `shape "${name}" must be seen by the call matcher`).toEqual(['multipart']);
    }
  });

  it('POSITIVE CONTROL: a raw request to the path is seen in every quote style', () => {
    // The helper exists so that the header cannot be omitted at one of two sites. A caller
    // that bypasses it and builds its own request is the shape that defeats every other
    // guard in this change, so it has to be visible here — and a literal is a literal
    // whichever quote it wears.
    for (const literal of [`'${RELAY_PATH}'`, `"${RELAY_PATH}"`, `\`${RELAY_PATH}\``]) {
      const sf = parse(
        'src/x.ts',
        `export const go = (b: BodyInit) => fetch(${literal}, { body: b });`
      );
      expect(countPathLiteralsInCode(sf), `quote style ${literal[0]} must be seen`).toBe(1);
    }
    // 🔴 AND AN INTERPOLATED BASE, which is why the match is on the path TAIL rather than
    // the whole path. Measured as an escape before that change: a `fetch` against
    // `` `${BASE}/image-upload/relay` `` left every test green.
    const interpolated = parse(
      'src/x.ts',
      'declare const BASE: string;\n' +
        'export const go = (b: BodyInit) => fetch(`${BASE}/image-upload/relay`, { body: b });'
    );
    expect(countPathLiteralsInCode(interpolated)).toBe(1);
    // And a path written in PROSE is not a caller — which is what makes the parse better
    // than a text scan, rather than merely different. Several production modules document
    // the route in a comment and would otherwise register as callers with no producer. (No
    // count here on purpose: an earlier comment in this change carried one and it was
    // already wrong when written.)
    const prose = parse(
      'src/x.ts',
      `// see ${RELAY_PATH}\n/** and \`${RELAY_PATH}\` */\nexport const n = 1;`
    );
    expect(countPathLiteralsInCode(prose)).toBe(0);
    // ⚠ And the limit, pinned rather than described: a path split ACROSS the tail by
    // concatenation is NOT seen. Asserting it keeps the limits list honest — if someone
    // closes this, the test tells them to update the list.
    const split = parse(
      'src/x.ts',
      `export const go = (b: BodyInit) => fetch('/api/v1/image-upload' + '/relay', { body: b });`
    );
    expect(countPathLiteralsInCode(split), 'known limit — see the limits list above').toBe(0);
  });
});
