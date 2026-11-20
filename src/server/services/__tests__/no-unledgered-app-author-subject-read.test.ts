import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `ctx.appBlocksAuthorSubject` is the request's account with its moderator flag, which a scoped
 * key or an app token withholds from `ctx.user` (`withModeratorRightsFor`). Read anywhere but the
 * App Blocks author gates, it would hand moderator rights back to that credential. So its readers
 * are a ledger, per file and per occurrence in the syntax tree (comments are not in it): this fails
 * when a read is added or one disappears. Add a reader only for the author capability, and update
 * the ledger here.
 */

const root = path.join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const files = sourceFiles(root).map((file) => ({
  file,
  name: path.relative(root, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/**
 * Per file, the identifiers and string literals spelled `word` (a property key in `Pick<…, 'x'>` is
 * a string literal). Parsed, not pattern-matched, so a comment never counts and never hides code.
 * Files whose text does not contain the word are skipped before parsing.
 */
function occurrences(word: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { file, name, text } of files) {
    if (!text.includes(word)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    let count = 0;
    const visit = (node: ts.Node) => {
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === word) count++;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (count) counts[name] = count;
  }
  return counts;
}

describe('no-unledgered-app-author-subject-read', () => {
  it('scans the source tree', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it('names the subject field only where it is set, typed and resolved', () => {
    expect(occurrences('appBlocksAuthorSubject')).toEqual({
      'server/auth/full-user-credential.ts': 2,
      'server/createContext.ts': 4,
    });
  });

  // Each count is the definition, or one import plus one call. An aliased import still counts.
  it('resolves the author account only in the two author gates', () => {
    expect(occurrences('appBlocksAuthorAccount')).toEqual({
      'server/auth/full-user-credential.ts': 1,
      'server/trpc.ts': 2,
      'server/trpc/app-blocks-author.middleware.ts': 2,
    });
  });
});
