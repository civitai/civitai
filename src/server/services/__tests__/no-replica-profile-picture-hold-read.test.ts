import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * "ProfilePictureHold" is granted to the write role only: a query naming it on a read-replica client
 * fails with a permission error, and the table must never reach a public payload. So every file that
 * names it is listed here, with how many lines do. A new use fails this test until someone has checked
 * it runs on dbWrite and is not part of a public select.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const PATTERN = /ProfilePictureHold|profilePictureHold/;

// Files that exist for the table: none may import a read client at all.
const DEDICATED: Record<string, number> = {
  'src/server/services/profile-picture-hold.service.ts': 6,
  'src/server/notifications/primary-notification-queries.ts': 2,
  'src/server/services/personal-data-export/sources/profile-pictures.ts': 1,
  'apps/moderator/src/lib/server/profile-picture-hold.ts': 4,
};
// Shared files: each use was read and runs on dbWrite (or a dbWrite transaction).
const SHARED: Record<string, number> = {
  // getProfilePictureUserIds and deleteProfilePictureHoldsSql (in deleteUser's transaction).
  'src/server/services/user.service.ts': 6,
  // isExemptFromAiVerification.
  'src/server/services/image-scan-result.service.ts': 1,
  // unusedAuthorImage (every caller passes dbWrite or a dbWrite transaction), and the cover check.
  'src/server/services/article.service.ts': 2,
  // The EXCLUDED reason, a string.
  'src/server/services/personal-data-export/registry.ts': 1,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.(ts|tsx|svelte)$/.test(name) || /\.test\.|\.spec\./.test(name)) return [];
    return [full];
  });
}

function uses() {
  const found: Record<string, number> = {};
  for (const dir of ['src', 'apps']) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => PATTERN.test(l)).length;
      if (lines) found[path.relative(ROOT, file)] = lines;
    }
  }
  return found;
}

describe('ProfilePictureHold access', () => {
  const found = uses();

  it('is named only in the reviewed files, as often as reviewed', () => {
    expect(found).toEqual({ ...DEDICATED, ...SHARED });
  });

  it('the dedicated files import no read-replica client', () => {
    for (const file of Object.keys(DEDICATED)) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      expect(text, file).not.toMatch(/\b(dbRead|pgDbRead|pgDbReadLong|kyselyRead)\b/);
    }
  });

  // A line naming the table in a shared file must not sit in a statement on a read client: the
  // statement opening within the few lines above it must not name one.
  it('the shared files read it on no read-replica client', () => {
    for (const file of Object.keys(SHARED)) {
      const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!PATTERN.test(line)) return;
        const before = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
        expect(before, `${file}:${i + 1}`).not.toMatch(
          /\b(dbRead|pgDbRead|pgDbReadLong|kyselyRead)\b/
        );
      });
    }
  });

  it('is in no selector, router or API route, so neither it nor its reason reaches a response', () => {
    const exposed = Object.keys(found).filter((f) =>
      /^src\/(server\/(selectors|routers)|pages\/api)\//.test(f)
    );
    expect(exposed).toEqual([]);
  });
});
