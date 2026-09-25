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
 *     a parameter, a class field — is not followed.
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
/** The prefilter spellings. See the limits above — this is the one spelling that remains. */
const TEXT_HINTS = [HELPER_EXPORT, 'image-upload/relay'];

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

/** Local names in this module that hold the helper function, or its module namespace. */
function bindingsOf(sf: ts.SourceFile, rel: string): { direct: Set<string>; ns: Set<string> } {
  const direct = new Set<string>();
  const ns = new Set<string>();
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
      if (ts.isIdentifier(init) && direct.has(init.text) && ts.isIdentifier(node.name))
        direct.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { direct, ns };
}

/** Is this call expression a call of the helper, under any local binding? */
function isHelperCall(
  call: ts.CallExpression,
  b: { direct: Set<string>; ns: Set<string> }
): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return b.direct.has(callee.text);
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    b.ns.has(callee.expression.text)
  ) {
    return callee.name.text === HELPER_EXPORT;
  }
  return false;
}

/** The `producer:` literal a call site declares, or a marker that turns the ledger red. */
function producerOf(call: ts.CallExpression): string {
  const opts = call.arguments[1];
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

/** Does this module build a request against the relay path, as a literal in CODE? */
function mentionsPathInCode(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      node.getText(sf).includes(RELAY_PATH)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function scan(): { sites: Site[]; parsed: number; candidates: string[] } {
  const files: string[] = [];
  for (const root of ROOTS) walkFiles(path.join(REPO_ROOT, root), files);

  const sites: Site[] = [];
  const candidates: string[] = [];
  let parsed = 0;
  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (!isProductionFile(rel)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const ledgered = CALLER_LEDGER.some((s) => s.file === rel);
    // Ledgered files are parsed unconditionally, so the prefilter can never drop one.
    if (!ledgered && !TEXT_HINTS.some((hint) => text.includes(hint))) continue;
    candidates.push(rel);
    const sf = parse(rel, text);
    parsed += 1;
    const bindings = bindingsOf(sf, rel);

    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isHelperCall(node, bindings)) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const call of calls) sites.push({ file: rel, producer: producerOf(call) });
    // A module that builds its own request to the path is a caller too — that is precisely
    // what the shared helper exists to prevent, so it must not be invisible here. The
    // helper's own module is exempt: it holds the path because it IS the helper.
    if (!calls.length && rel !== HELPER_MODULE && mentionsPathInCode(sf)) {
      sites.push({ file: rel, producer: '<raw-request>' });
    }
  }
  return { sites, parsed, candidates };
}

describe('the relay caller ledger', () => {
  const { sites, parsed, candidates } = scan();

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
    // Named, not just counted: the route itself mentions its own path, so it is the file
    // whose admission proves the text hints reach real code rather than an empty set.
    expect(admittedOnItsOwn).toContain('src/pages/api/v1/image-upload/relay.ts');
  });

  it('POSITIVE CONTROL: the call matcher sees a caller written in a shape unlike the real ones', () => {
    // 🔴 The control the first draft of this guard lacked, and the reason it was fail-open:
    // it was only ever exercised against the two call shapes already in the tree, so every
    // shape it could NOT see went unnoticed. This parses synthetic modules covering the
    // seven shapes that defeated it and asserts each is found — an aliased import, a
    // namespace call, a dynamic-import destructure, a local rebinding, and argument
    // expressions that are not bare identifiers.
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
    ];

    for (const [name, source] of shapes) {
      const rel = 'src/hooks/__synthetic__.ts';
      const sf = parse(rel, source);
      const bindings = bindingsOf(sf, rel);
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && isHelperCall(node, bindings)) found.push(producerOf(node));
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
      expect(mentionsPathInCode(sf), `quote style ${literal[0]} must be seen`).toBe(true);
    }
    // And a path written in PROSE is not a caller — which is what makes the parse better
    // than a text scan, rather than merely different. Both production modules that document
    // the route in a comment would otherwise register as callers with no producer.
    const prose = parse(
      'src/x.ts',
      `// see ${RELAY_PATH}\n/** and \`${RELAY_PATH}\` */\nexport const n = 1;`
    );
    expect(mentionsPathInCode(prose)).toBe(false);
  });
});
