import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Seam guard for the download path's client-IP derivation.
 *
 * The behavioural tests in this directory each verify ONE endpoint. What no
 * per-endpoint test can see is a FIFTH endpoint appearing that derives its own
 * address, or an existing one quietly reverting to a local derivation — the
 * defect would live in the seam none of those tests owns.
 *
 * So this asserts the relationship: an explicit ledger of every download route
 * that consumes a client IP, failing when the set grows OR shrinks, plus the
 * rule that the derivation is imported and never re-implemented. Structural by
 * nature — it is the complement to, not a substitute for, the behavioural
 * tests, which are what prove the shared predicate actually does the right
 * thing.
 */

const DOWNLOAD_API_DIR = path.resolve(__dirname, '../../../../pages/api/download');

/**
 * Every download route that derives a client IP. Adding a route here is a
 * deliberate act; the assertions below fail if reality and this list diverge in
 * either direction.
 */
const LEDGER = [
  '[...key].ts',
  'attachments/[fileId].ts',
  'models/[modelVersionId].ts',
  'vault/[vaultItemId].ts',
].sort();

/** The one sanctioned derivation. */
const SHARED_RESOLVER = 'getTrustedClientIp';

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

const files = walk(DOWNLOAD_API_DIR).map((full) => ({
  rel: path.relative(DOWNLOAD_API_DIR, full).split(path.sep).join('/'),
  source: fs.readFileSync(full, 'utf8'),
}));

describe('download endpoints — client-IP derivation ledger', () => {
  it('POSITIVE CONTROL: the walk found the download routes it is meant to scan', () => {
    // A ledger built from an empty scan would satisfy every assertion below.
    expect(files.length).toBeGreaterThanOrEqual(LEDGER.length);
    expect(files.map((f) => f.rel).sort()).toEqual(expect.arrayContaining(LEDGER));
  });

  it('the set of routes deriving a client IP matches the ledger exactly', () => {
    const deriving = files
      .filter((f) => f.source.includes(SHARED_RESOLVER))
      .map((f) => f.rel)
      .sort();
    expect(deriving).toEqual(LEDGER);
  });

  it('every ledger route imports the derivation rather than re-implementing it', () => {
    for (const rel of LEDGER) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `${rel} is in the ledger but not on disk`).toBeDefined();
      expect(file!.source, rel).toMatch(
        /import\s*\{[^}]*\bgetTrustedClientIp\b[^}]*\}\s*from\s*'~\/server\/utils\/client-ip'/
      );
    }
  });

  it('no download route derives a client IP locally', () => {
    for (const file of files) {
      // `request-ip` resolves from forwarding headers the caller composes,
      // which is not a basis an enforcement control can use.
      expect(file.source, `${file.rel} imports request-ip`).not.toMatch(
        /from\s*'request-ip'|require\(\s*'request-ip'\s*\)/
      );
      // A hand-rolled read of the edge headers is the other way this drifts.
      expect(file.source, `${file.rel} reads cf-connecting-ip directly`).not.toContain(
        "headers['cf-connecting-ip']"
      );
    }
  });
});
