import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `BlockManifestValidator.validate` skips the surface rule; `validateSubmission` adds it (and the
 * ReDoS check). A production path that reached `validate` directly would accept a manifest the
 * build pipeline refuses after approval. So the only reference to `validate` in production code is
 * the `this.validate(` inside `validateSubmission`.
 *
 * The scan parses each file (as `.ts` or `.tsx` by its extension; a file that does not parse
 * cleanly fails the guard), so a name in a comment, a string or a type (`typeof X.validate`) is not
 * a reference. It follows the class through a renamed import, a namespace import, a destructure
 * (in a declaration or a parameter, so `.then(({ BlockManifestValidator: V }) => …)` too), a
 * `const V = BlockManifestValidator` alias including one behind `??`, `||` or `?:`, and a subclass.
 * It catches `validate` destructured out of the class, nested destructures included, read as a
 * value (`.call`, `.bind`, passed along), or reached through `super`.
 *
 * Not caught: the class re-exported under another name from a file that never spells
 * `BlockManifestValidator` (files are prefiltered on that name); rebinding by assignment, an object
 * property or a positional parameter; and computed access (`Reflect.get`, a key in a variable,
 * a rest pattern).
 */

const REPO = path.resolve(__dirname, '../../../..');
const CLASS = 'BlockManifestValidator';
const DEFINING_FILE = 'src/server/services/block-manifest-validator.service.ts';
const ALLOWED_OWNER = 'validateSubmission';

const MESSAGE =
  'production code must call BlockManifestValidator.validateSubmission, not validate: ' +
  'validate skips the surface rule the build pipeline enforces';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'tests' ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.(test|spec|stories)\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isAwaitExpression(n) ||
    ts.isSatisfiesExpression(n)
  )
    n = n.expression;
  return n;
}

function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text;
  return undefined;
}

function enclosing<T extends ts.Node>(node: ts.Node, is: (n: ts.Node) => n is T): T | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (is(n)) return n;
  return undefined;
}

function bindingKey(el: ts.BindingElement): string | undefined {
  const key = el.propertyName ?? el.name;
  return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
}

/**
 * Every reference to `validate` on the class in `source`, as `line: text` strings. `inDefiningFile`
 * also counts `this.validate` inside the class itself, allowing it only in `validateSubmission`.
 */
function directValidateRefs(source: string, fileName = 'x.ts', inDefiningFile = false): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  // A broken parse silently drops everything after the error, so it is a failure, not a pass.
  const parseErrors = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (!Array.isArray(parseErrors)) throw new Error('typescript no longer exposes parseDiagnostics');
  if (parseErrors.length > 0)
    throw new Error(
      `${fileName} does not parse: ${ts.flattenDiagnosticMessageText(
        parseErrors[0].messageText,
        ' '
      )}`
    );
  const classNames = new Set<string>([CLASS]);

  const isClassExpr = (expr: ts.Expression): boolean => {
    const e = unwrap(expr);
    if (ts.isIdentifier(e)) return classNames.has(e.text);
    if (ts.isConditionalExpression(e)) return isClassExpr(e.whenTrue) || isClassExpr(e.whenFalse);
    if (
      ts.isBinaryExpression(e) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(e.operatorToken.kind)
    )
      return isClassExpr(e.left) || isClassExpr(e.right);
    // `mod.BlockManifestValidator`, `(await import('…')).BlockManifestValidator`
    return memberName(e) === CLASS;
  };

  const extendsClass = (cls: ts.ClassLikeDeclaration) =>
    !!cls.heritageClauses?.some(
      (h) =>
        h.token === ts.SyntaxKind.ExtendsKeyword && h.types.some((t) => isClassExpr(t.expression))
    );

  // Learn aliases of the class to a fixed point: renamed imports, `const V = <class>`, a destructure
  // `{ BlockManifestValidator: V }` anywhere (declaration or parameter), and a subclass.
  const learn = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === CLASS)
      classNames.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.name) &&
      isClassExpr(node.initializer)
    )
      classNames.add(node.name.text);
    if (ts.isBindingElement(node) && bindingKey(node) === CLASS && ts.isIdentifier(node.name))
      classNames.add(node.name.text);
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && extendsClass(node)) {
      const name =
        node.name ??
        (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
          ? node.parent.name
          : undefined);
      if (name && name.text !== CLASS) classNames.add(name.text);
    }
    ts.forEachChild(node, learn);
  };

  // A destructuring pattern whose value is the class: `= <class>`, or nested under a
  // `BlockManifestValidator:` key.
  const patternIsClass = (pattern: ts.ObjectBindingPattern): boolean => {
    const p = pattern.parent;
    if (ts.isVariableDeclaration(p)) return !!p.initializer && isClassExpr(p.initializer);
    if (ts.isBindingElement(p)) return bindingKey(p) === CLASS;
    return false;
  };
  for (let size = -1; size !== classNames.size; ) {
    size = classNames.size;
    learn(sf);
  }

  const refs: string[] = [];
  const report = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    refs.push(`${line + 1}: ${node.getText().replace(/\s+/g, ' ')}`);
  };

  const visit = (node: ts.Node) => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      memberName(node) === 'validate'
    ) {
      const target = unwrap(node.expression);
      if (isClassExpr(target)) report(node);
      else if (
        target.kind === ts.SyntaxKind.SuperKeyword ||
        target.kind === ts.SyntaxKind.ThisKeyword
      ) {
        // `super.validate` / `this.validate` in a subclass; `this.validate` in the class itself
        // outside validateSubmission.
        const cls = enclosing(node, ts.isClassLike);
        const method = enclosing(node, ts.isMethodDeclaration);
        const inAllowedOwner =
          !!method && ts.isIdentifier(method.name) && method.name.text === ALLOWED_OWNER;
        if (cls && extendsClass(cls)) report(node);
        else if (inDefiningFile && cls?.name?.text === CLASS && !inAllowedOwner) report(node);
      }
    }
    // `const { validate } = BlockManifestValidator`, `{ BlockManifestValidator: { validate } }`
    if (
      ts.isBindingElement(node) &&
      bindingKey(node) === 'validate' &&
      ts.isObjectBindingPattern(node.parent) &&
      patternIsClass(node.parent)
    )
      report(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

describe('no production code reaches BlockManifestValidator.validate directly', () => {
  const files = sourceFiles(path.join(REPO, 'src'));
  const rel = (f: string) => path.relative(REPO, f).split(path.sep).join('/');

  it('the walk reaches the validator and a known submission caller', () => {
    const paths = files.map(rel);
    expect(paths).toContain(DEFINING_FILE);
    expect(paths).toContain('src/pages/api/internal/blocks/git-push.ts');
  });

  it.each([
    ['a direct call', `BlockManifestValidator.validate(m, ctx);`],
    ['a renamed import', `import { BlockManifestValidator as V } from '~/x';\nV.validate(m, ctx);`],
    ['an alias', `const V = BlockManifestValidator;\nV.validate(m, ctx);`],
    ['a chained alias', `const A = BlockManifestValidator;\nconst B = A;\nB.validate(m);`],
    [
      'a dynamic import destructure, renamed',
      `const { BlockManifestValidator: V } = await import('~/x');\nV.validate(m);`,
    ],
    ['a namespace import', `import * as mod from '~/x';\nmod.BlockManifestValidator.validate(m);`],
    ['element access', `BlockManifestValidator['validate'](m);`],
    ['a destructure', `const { validate } = BlockManifestValidator;\nvalidate(m);`],
    ['a renamed destructure', `const { validate: v } = BlockManifestValidator;\nv(m);`],
    ['.call', `BlockManifestValidator.validate.call(null, m);`],
    ['passed as a value', `manifests.map(BlockManifestValidator.validate);`],
    ['an alias behind ??', `const V = injected ?? BlockManifestValidator;\nV.validate(m);`],
    ['an alias behind ?:', `const V = strict ? other : BlockManifestValidator;\nV.validate(m);`],
    [
      'a nested destructure',
      `const { BlockManifestValidator: { validate } } = await import('~/x');\nvalidate(m);`,
    ],
    [
      'a parameter destructure',
      `import('~/x').then(({ BlockManifestValidator: V }) => V.validate(m));`,
    ],
    ['a subclass', `class Strict extends BlockManifestValidator {}\nStrict.validate(m);`],
    [
      'super in a subclass',
      `class Strict extends BlockManifestValidator {\n  static run(m) { return super.validate(m); }\n}`,
    ],
    [
      'a call after a generic arrow',
      `export const id = <T,>(x: T): T => x;\nBlockManifestValidator.validate(id(m));`,
    ],
  ])('the scan sees %s', (_case, source) => {
    expect(directValidateRefs(source)).toHaveLength(1);
  });

  it.each([
    ['validateSubmission', `await BlockManifestValidator.validateSubmission(m, ctx);`],
    ['a comment', `// BlockManifestValidator.validate(m)\n/* BlockManifestValidator.validate */`],
    ['a string', `const s = 'BlockManifestValidator.validate(m)';`],
    ['a type', `type R = ReturnType<typeof BlockManifestValidator.validate>;`],
    ['another object', `schema.validate(m);\nconst { validate } = other;`],
    ['this.validate outside the defining class', `this.validate(m);`],
    [
      'a subclass of something else',
      `class S extends Base {\n  run() { return super.validate(); }\n}`,
    ],
  ])('the scan ignores %s', (_case, source) => {
    expect(directValidateRefs(source)).toEqual([]);
  });

  it('in the defining class, this.validate is allowed only inside validateSubmission', () => {
    const cls = (method: string) =>
      `class BlockManifestValidator {\n  static validate() {}\n  static ${method}() { return this.validate(); }\n}`;
    expect(directValidateRefs(cls('validateSubmission'), 'x.ts', true)).toEqual([]);
    expect(directValidateRefs(cls('validateLoosely'), 'x.ts', true)).toHaveLength(1);
    // Another class in the same file has its own `validate`.
    const other = `class Other {\n  validate() {}\n  run() { return this.validate(); }\n}`;
    expect(directValidateRefs(other, 'x.ts', true)).toEqual([]);
  });

  it('parses by extension and refuses a file that does not parse', () => {
    // As .tsx this generic arrow is JSX, and the parse would swallow the call after it.
    const generic = `const id = <T>(x: T): T => x;\nBlockManifestValidator.validate(m);`;
    expect(directValidateRefs(generic, 'x.ts')).toHaveLength(1);
    expect(() => directValidateRefs(generic, 'x.tsx')).toThrow(/does not parse/);
  });

  it('validateSubmission is the one caller of validate', () => {
    // POSITIVE CONTROL: the allowed `this.validate(` is really there for the scan to exempt.
    const defining = readFileSync(path.join(REPO, DEFINING_FILE), 'utf8');
    expect(defining).toMatch(/static async validateSubmission\([\s\S]*?this\.validate\(/);

    const found = files
      .map((f) => {
        const source = readFileSync(f, 'utf8');
        if (!source.includes(CLASS)) return [];
        const file = rel(f);
        return directValidateRefs(source, file, file === DEFINING_FILE).map((r) => `${file}:${r}`);
      })
      .flat();
    expect(found, MESSAGE).toEqual([]);
  });
});
