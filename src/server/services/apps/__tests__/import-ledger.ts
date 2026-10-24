// Every module import in `src` (static `import`/`export … from`, `import()` and `require`),
// parsed with the TypeScript AST — for ledger tests that pin exactly which modules may obtain
// a capability. Structural, not spelled: an alias or a re-export cannot hide an import.
// Enumerated with fs: the wrapped grep honours .gitignore. Test files are not importers.
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '../../../..');

/** `names` is the value bindings taken (`[]` for a type-only import), or `'all'`. */
export type ImportUse = { file: string; module: string; names: string[] | 'all' };

/** A specifier as a src-relative module path without extension, or null for a package. */
function resolveSpec(file: string, spec: string): string | null {
  if (spec.startsWith('~/')) return spec.slice(2);
  if (spec.startsWith('.')) {
    return path
      .relative(SRC, path.resolve(path.dirname(file), spec))
      .split(path.sep)
      .join('/');
  }
  return null;
}

function importsOf(file: string): ImportUse[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const out: ImportUse[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) {
        const target = resolveSpec(file, spec.text);
        if (target) {
          let names: string[] | 'all' = 'all';
          if (ts.isImportDeclaration(node)) {
            const b = node.importClause?.namedBindings;
            if (node.importClause?.isTypeOnly) names = [];
            else if (b && ts.isNamedImports(b)) {
              names = b.elements
                .filter((e) => !e.isTypeOnly)
                .map((e) => e.propertyName?.text ?? e.name.text);
            }
          }
          out.push({ file: rel, module: target, names });
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const target = resolveSpec(file, node.arguments[0].text);
      if (target) out.push({ file: rel, module: target, names: 'all' });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === '__tests__') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

let cached: ImportUse[] | undefined;

/** Every import in `src`, parsed once per test file. */
export function srcImports(): ImportUse[] {
  return (cached ??= walk(SRC, []).flatMap(importsOf));
}

/**
 * The files that import `module` at all, or — with `name` — that take that value binding from
 * it (an `'all'` import such as `import()` or a namespace import counts), sorted and unique.
 */
export function importersOf(module: string, name?: string): string[] {
  const files = srcImports()
    .filter((u) => u.module === module && (!name || u.names === 'all' || u.names.includes(name)))
    .map((u) => u.file);
  return [...new Set(files)].sort();
}
