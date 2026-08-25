import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE LEDGER OF EVERY CALLER THAT MINTS FORGEJO `write` ON AN APP REPO.
 *
 * ## Why this file exists
 *
 * `assertSeatGrantable` (in `app-collaborator.service.ts`) carries a docblock reading
 * "🔴 IT GUARDS THE TWO GRANT PATHS ONLY". That sentence was written about the two paths
 * the author was looking at — `invite` and an ACCEPT — and it reads as an ENUMERATION of
 * the repo-grant surface. It is not one. An audit found a THIRD caller:
 * `app-ownership-transfer.service.ts` grants `write` to the recipient on transfer accept,
 * and neither `initiateTransfer` nor `acceptTransfer` reads the listing's status —
 * `loadOwnedListing` there does not even SELECT it.
 *
 * A prose claim that reads as complete and is not is exactly the shape that gets cited as
 * proof of coverage later, so the claim is replaced by a check. This file enumerates the
 * call sites and asserts the exact set, failing when it GROWS **or** SHRINKS — the second
 * direction matters as much, because a caller that moves or is renamed silently leaves the
 * ledger describing a surface that no longer exists.
 *
 * ## What is guarded, and what is knowingly NOT
 *
 *   - `app-collaborator.service.ts` — seat ACCEPT. **Status-guarded** by this PR
 *     (`assertSeatGrantable`), together with its `invite` sibling that creates the pending
 *     row. Pinned by `app-collaborator.seat-grant-status.test.ts`.
 *   - `app-ownership-transfer.service.ts` — ownership transfer ACCEPT. **NOT status-guarded,
 *     deliberately and out of scope for this PR**, recorded here rather than left implied:
 *       * it is PRE-EXISTING and unchanged by this PR;
 *       * it is consented at both ends (the owner initiates, the recipient accepts);
 *       * a push cannot deploy while the backing block is `suspended`; and
 *       * the case a status guard would break is REAL and sympathetic — an owner
 *         unpublishes their own app and then hands it over ("I'm stepping back"), which is
 *         the single most likely legitimate transfer of a `removed` listing. Blocking that
 *         to close a consented, non-deploying path is the wrong trade to make in passing.
 *     The residual exposure is that a moderator-delisted app can still change hands, with
 *     the recipient gaining repo `write` — worth closing on its own, with its own decision
 *     about the owner-unpublished case, not as a footnote to a tab-set PR.
 *
 * 🔴 If you add a caller, add it here WITH which of the two categories it is in. If it
 * grants `write` on a listing whose status nobody checked, say so in its reason string
 * rather than quietly extending the guarded list.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SRC = path.join(REPO_ROOT, 'src');

/**
 * The declared surface: file → why this caller is or is not status-guarded.
 *
 * Paths are repo-relative and `/`-normalised so the assertion reads the same on any host.
 */
const DECLARED: Record<string, string> = {
  'src/server/services/blocks/app-collaborator.service.ts':
    'seat accept — STATUS-GUARDED by assertSeatGrantable (with its invite sibling)',
  'src/server/services/blocks/app-ownership-transfer.service.ts':
    'ownership-transfer accept — NOT status-guarded; pre-existing, consented both ends, ' +
    'cannot deploy while suspended, and a guard would break an owner-unpublished handover',
};

/** Every non-test source file that CALLS `grantAppRepoWrite`. Its definition is excluded. */
function callers(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        const src = fs.readFileSync(full, 'utf8');
        // A CALL, not the declaration or a re-export: `grantAppRepoWrite(` with no
        // `function`/`export` immediately before it.
        if (!/(?<!function\s)\bgrantAppRepoWrite\s*\(/.test(src)) continue;
        if (/export\s+async\s+function\s+grantAppRepoWrite\b/.test(src)) continue;
        out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(SRC);
  return out.sort();
}

describe('the Forgejo repo-write grant surface', () => {
  /**
   * 🔴 POSITIVE CONTROL. Everything below is a claim about a set of files; if the walk
   * returns nothing — a moved directory, a bad regex, a changed extension — every one of
   * those claims is vacuously true and this file reports success while checking nothing.
   */
  it('actually found the grant call sites', () => {
    expect(callers().length).toBeGreaterThan(0);
  });

  it('🔴 is EXACTLY the declared set — fails when it grows AND when it shrinks', () => {
    // Set equality, not `toContain`. A new caller that mints repo write without anyone
    // deciding whether it needs a status guard is precisely the thing this catches, and a
    // caller that DISAPPEARS is caught too, so the reasons above cannot go on describing a
    // surface that has moved.
    expect(callers()).toEqual(Object.keys(DECLARED).sort());
  });

  it('every declared caller carries a reason', () => {
    // An entry without one is how a real gap gets parked: the file keeps passing while the
    // question "is this one guarded?" stops being asked.
    for (const [file, reason] of Object.entries(DECLARED)) {
      expect(reason.length, `${file} has no reason`).toBeGreaterThan(20);
    }
  });

  /**
   * 🔴 THE ASYMMETRY IS THE POINT, and it is asserted rather than described. The seat path
   * imports the status predicate; the transfer path does not read the column at all. If
   * someone later guards transfer, this case goes red and they come here to move the entry
   * — which is the whole mechanism keeping the reason strings true.
   */
  it('the seat path reads the listing status and the transfer path does not', () => {
    const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const seat = read('src/server/services/blocks/app-collaborator.service.ts');
    const transfer = read('src/server/services/blocks/app-ownership-transfer.service.ts');
    expect(seat).toContain('assertSeatGrantable');
    expect(seat).toContain('isAuthorableListingStatus');
    expect(transfer).not.toContain('isAuthorableListingStatus');
    expect(transfer).not.toContain('assertSeatGrantable');
  });
});
