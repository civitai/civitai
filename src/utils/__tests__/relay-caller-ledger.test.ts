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
 * the defect comes back, because `postImageUploadRelay`'s `producer` parameter is typed to
 * the label union, so a new call site is FORCED to reuse `single_put` or `multipart` to
 * compile and its traffic is then added to a row someone is already grading.
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
 * either NAME `postImageUploadRelay` somewhere in it — an alias still writes it in the
 * import clause, a namespace call still writes it at the member access, `(0, f)` still
 * needs the binding — or write the PATH. So this asserts:
 *
 *   1. the set of production modules that reference the helper, or name the path in code,
 *      is exactly the ledger; and
 *   2. inside the helper module, there is exactly ONE `fetch(` — which is what stops a
 *      SECOND relay request being written there using the module-local path constant, a
 *      shape that referenced nothing new and escaped the previous version.
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
 *   - A module reached through a COMPUTED specifier and a computed property access
 *     (`mod['post' + 'ImageUploadRelay']`) names the identifier nowhere. Nothing short of
 *     type-checking sees that, and it is not a shape anyone writes by accident.
 *   - A path assembled so that the matched tail never appears as one literal
 *     (`'/api/v1/image-upload' + '/relay'`). Pinned by a case below, so closing it makes
 *     that case fail and this line gets updated.
 *   - Reachability is not evaluated: a call behind a flag still counts as a reference.
 *   - The PREFILTER is a spelling — only files whose raw text mentions the identifier or
 *     the path tail are parsed. Its own control is below, and it is deliberately built on a
 *     hard-coded corpus rather than on `TEXT_HINTS`, because a control that interpolates
 *     the thing under test into its own fixture can never fail.
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
 * make one, and a caller nobody scans is a caller nobody ledgers.
 */
const ROOTS = ['src', 'apps', 'packages'];

const HELPER_MODULE = 'src/utils/upload-settlement.ts';
const HELPER_EXPORT = 'postImageUploadRelay';
const RELAY_PATH = '/api/v1/image-upload/relay';
/**
 * The tail, DERIVED rather than re-typed, so a route rename cannot leave two spellings
 * disagreeing. Matching the tail rather than the whole path is what catches an
 * interpolated base — `` fetch(`${BASE}/image-upload/relay`) ``.
 */
const RELAY_PATH_TAIL = RELAY_PATH.slice(RELAY_PATH.indexOf('/image-upload/'));

/** Prefilter spellings, both derived from the constants above. See the limits list. */
const TEXT_HINTS = [HELPER_EXPORT, RELAY_PATH_TAIL.slice(1)];

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
 * Only the two real callers are here. The route, the metrics module and the producer module
 * all mention the path in PROSE and are correctly absent — that is the parse earning its
 * keep over a text scan.
 */
const CALLER_LEDGER = ['src/hooks/useCFImageUpload.tsx', HELPER_MODULE];

/** The helper module builds the one relay request there is. */
const EXPECTED_HELPER_FETCH_CALLS = 1;

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
  }
  return false;
}

/**
 * Does this module REFERENCE the relay — by naming the helper, or by naming the path in
 * code?
 *
 * 🔴 An identifier ANYWHERE in the module counts, in any syntactic role. That is the point:
 * it does not matter whether the reference is a call, an alias, a re-export, a property, a
 * `.call` receiver or a comma sequence — all of them write the name, so this cannot be
 * walked around by choosing a different call shape.
 */
function referencesRelay(sf: ts.SourceFile): { helper: boolean; pathLiterals: number } {
  let helper = false;
  let pathLiterals = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === HELPER_EXPORT && !isInertContext(node)) {
      helper = true;
    }
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

/** How many `fetch(...)` calls this module makes. See `EXPECTED_HELPER_FETCH_CALLS`. */
function countFetchCalls(sf: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        ? callee.expression.text
        : null;
      if (name === 'fetch') count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

function scan(): {
  referencing: string[];
  candidates: string[];
  helperFetchCalls: number;
  pathLiteralsByFile: Record<string, number>;
} {
  const files: string[] = [];
  for (const root of ROOTS) walkFiles(path.join(REPO_ROOT, root), files);

  const referencing: string[] = [];
  const candidates: string[] = [];
  const pathLiteralsByFile: Record<string, number> = {};
  let helperFetchCalls = -1;
  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (!isProductionFile(rel)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const ledgered = CALLER_LEDGER.includes(rel);
    // Ledgered files are parsed unconditionally, so the prefilter can never drop one.
    if (!ledgered && !isCandidateText(text)) continue;
    candidates.push(rel);
    const sf = parse(rel, text);
    const { helper, pathLiterals } = referencesRelay(sf);
    if (helper || pathLiterals > 0) referencing.push(rel);
    if (pathLiterals > 0) pathLiteralsByFile[rel] = pathLiterals;
    if (rel === HELPER_MODULE) helperFetchCalls = countFetchCalls(sf);
  }
  return { referencing, candidates, helperFetchCalls, pathLiteralsByFile };
}

describe('the relay caller ledger', () => {
  const { referencing, candidates, helperFetchCalls, pathLiteralsByFile } = scan();

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

  it('🔴 keeps the helper module to ONE fetch — the second-request shape that references nothing new', () => {
    // 🔴 THE HOLE THIS CLOSES, and it was live until a round-4 review planted it. The path
    // constant is module-local and unexported precisely so that no OTHER module can build
    // its own request — but inside this file it is a few lines away, so
    // `fetch(IMAGE_UPLOAD_RELAY_PATH, …)` adds a second relay request while naming no new
    // identifier and writing no new path literal. Every reference-based check is blind to
    // it by construction; counting the file's `fetch` calls is not.
    expect(helperFetchCalls, `${HELPER_MODULE} must make exactly one fetch`).toBe(
      EXPECTED_HELPER_FETCH_CALLS
    );
  });

  it('POSITIVE CONTROL: the sweep reaches real files and the parse finds real references', () => {
    // 🔴 A scan can walk thousands of files and match nothing — which returns an empty set,
    // and an empty set compared against an empty ledger is the reassuring zero this whole
    // change exists to stop believing.
    expect(candidates).toEqual(expect.arrayContaining(CALLER_LEDGER));
    expect(referencing.length, 'the parse must actually find references').toBeGreaterThan(1);
    expect(helperFetchCalls, 'the helper module must have been parsed at all').toBeGreaterThan(-1);
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
    expect(
      isCandidateText("import { postImageUploadRelay } from '~/utils/upload-settlement';"),
      'a module importing the helper must be admitted — the only way in for a third caller ' +
        'that names no path'
    ).toBe(true);
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

  it('POSITIVE CONTROL: prose and type positions are NOT references', () => {
    // The parse earning its keep over a text scan. Four production modules document the
    // route in a comment; a text-only guard would report every one of them as a caller.
    const inert: [string, string][] = [
      ['line comment', `// see ${RELAY_PATH}\nexport const n = 1;`],
      [
        'block comment',
        `/** calls \`${HELPER_EXPORT}\` at \`${RELAY_PATH}\` */\nexport const n = 1;`,
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
