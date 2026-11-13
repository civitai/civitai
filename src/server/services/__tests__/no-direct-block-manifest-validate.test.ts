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
 * The scan parses each file, so a name in a comment, a string or a type (`typeof X.validate`) is
 * not a reference. It follows the class through a renamed import, a namespace import, a dynamic
 * `import()` destructure and a `const V = BlockManifestValidator` alias, and it catches
 * `validate` destructured out of the class or read as a value (`.call`, `.bind`, passed along).
 *
 * Not caught: the class re-exported under another name from a file that never spells
 * `BlockManifestValidator` (files are prefiltered on that name), and rebinding other than a
 * `const`/`let`/`var` declaration (an assignment, a parameter, an object property).
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

function enclosingMethod(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent)
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
  return undefined;
}

/**
 * Every reference to `validate` on the class in `source`, as `line: text` strings. `inDefiningClass`
 * also counts `this.validate` (the class's own static methods), allowing it only in
 * `validateSubmission`.
 */
function directValidateRefs(source: string, inDefiningClass = false): string[] {
  const sf = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const classNames = new Set<string>([CLASS]);

  const isClassExpr = (expr: ts.Expression): boolean => {
    const e = unwrap(expr);
    if (ts.isIdentifier(e)) return classNames.has(e.text);
    // `mod.BlockManifestValidator`, `(await import('…')).BlockManifestValidator`
    return memberName(e) === CLASS;
  };

  // Learn aliases of the class to a fixed point: renamed imports, `const V = <class>`, and
  // `const { BlockManifestValidator: V } = …`.
  const learn = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === CLASS)
      classNames.add(node.name.text);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && isClassExpr(node.initializer))
        classNames.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name))
        for (const el of node.name.elements) {
          const key = el.propertyName ?? el.name;
          if (ts.isIdentifier(key) && key.text === CLASS && ts.isIdentifier(el.name))
            classNames.add(el.name.text);
        }
    }
    ts.forEachChild(node, learn);
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
        inDefiningClass &&
        target.kind === ts.SyntaxKind.ThisKeyword &&
        enclosingMethod(node) !== ALLOWED_OWNER
      )
        report(node);
    }
    // `const { validate } = BlockManifestValidator`
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name) &&
      isClassExpr(node.initializer)
    )
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) && key.text === 'validate') report(el);
      }
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
  ])('the scan ignores %s', (_case, source) => {
    expect(directValidateRefs(source)).toEqual([]);
  });

  it('in the defining class, this.validate is allowed only inside validateSubmission', () => {
    const cls = (method: string) =>
      `class BlockManifestValidator {\n  static validate() {}\n  static ${method}() { return this.validate(); }\n}`;
    expect(directValidateRefs(cls('validateSubmission'), true)).toEqual([]);
    expect(directValidateRefs(cls('validateLoosely'), true)).toHaveLength(1);
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
        return directValidateRefs(source, file === DEFINING_FILE).map((r) => `${file}:${r}`);
      })
      .flat();
    expect(found, MESSAGE).toEqual([]);
  });
});
