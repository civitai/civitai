import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { countAll, productionSources, walk } from './source-ratchet.harness';

/**
 * `ctx.appBlocksAuthorSubject` is the request's account with its moderator flag, which a scoped
 * key or an app token withholds from `ctx.user` (`withModeratorRightsFor`). Read anywhere but the
 * App Blocks author gates, it would hand moderator rights back to that credential. So its readers
 * are a ledger, per file and per occurrence in the syntax tree (comments are not in it): this fails
 * when a read is added or one disappears. Add a reader only for the author capability, and update
 * the ledger here.
 */

const files = productionSources(['src/**/*.{ts,tsx}']);

/** Identifiers and string literals spelled `word` (a key in `Pick<…, 'x'>` is a string literal). */
const occurrences = (word: string) =>
  countAll(files, word, (sf) => {
    let count = 0;
    walk(sf, (node) => {
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === word) count++;
    });
    return count;
  });

describe('no-unledgered-app-author-subject-read', () => {
  it('scans the source tree', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it('names the subject field only where it is set, typed and resolved', () => {
    expect(occurrences('appBlocksAuthorSubject')).toEqual({
      'src/server/auth/full-user-credential.ts': 2,
      'src/server/createContext.ts': 4,
    });
  });

  // Each count is the definition, or one import plus one call. An aliased import still counts.
  it('resolves the author account only in the two author gates', () => {
    expect(occurrences('appBlocksAuthorAccount')).toEqual({
      'src/server/auth/full-user-credential.ts': 1,
      'src/server/trpc.ts': 2,
      'src/server/trpc/app-blocks-author.middleware.ts': 2,
    });
  });
});
