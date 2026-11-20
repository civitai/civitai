import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `ctx.appBlocksAuthorSubject` is the request's account with its moderator flag, which a scoped
 * key or an app token withholds from `ctx.user` (`withModeratorRightsFor`). Read anywhere but the
 * App Blocks author gates, it would hand moderator rights back to that credential. So its readers
 * are a ledger, per file and per occurrence, outside comments: this fails when a read is added or
 * one disappears. Add a reader only for the author capability, and update the ledger here.
 */

const root = path.join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// Block comments, then line comments that do not follow a `:` (so a URL in a string survives).
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const files = sourceFiles(root).map((file) => ({
  name: path.relative(root, file).split(path.sep).join('/'),
  code: withoutComments(readFileSync(file, 'utf8')),
}));

const occurrences = (pattern: RegExp) =>
  Object.fromEntries(
    files
      .map(({ name, code }) => [name, code.match(pattern)?.length ?? 0] as const)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b))
  );

describe('no-unledgered-app-author-subject-read', () => {
  it('scans the source tree', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it('names the subject field only where it is set, typed and resolved', () => {
    expect(occurrences(/\bappBlocksAuthorSubject\b/g)).toEqual({
      'server/auth/full-user-credential.ts': 2,
      'server/createContext.ts': 4,
    });
  });

  // The definition (`appBlocksAuthorAccount<T …>(`) is the one occurrence in full-user-credential.
  it('resolves the author account only in the two author gates', () => {
    expect(occurrences(/\bappBlocksAuthorAccount\s*(<[^>]*>)?\(/g)).toEqual({
      'server/auth/full-user-credential.ts': 1,
      'server/trpc.ts': 1,
      'server/trpc/app-blocks-author.middleware.ts': 1,
    });
  });
});
