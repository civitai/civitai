import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { PRIOR_BLOCKED_FOR_KEY, PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';

/**
 * The account-deletion grace block writes two `Image.metadata` breadcrumbs so a later account
 * restore can undo exactly what it did. `unblockAccountDeletionImages` restores an image on the
 * presence of the first one ALONE, so any moderation block that leaves them on hands a restore the
 * right to un-block moderated content — including CSAM-blocked content, which is the ordering that
 * makes this worth a guard: self-delete with the 7-day grace option marks every image, a report
 * lands on day 3, a moderator blocks, the account is later restored.
 *
 * Every moderation block therefore strips both keys. The main app's sites do it through
 * `clearAccountDeletionImageMarkers`, and their behaviour is pinned in
 * `src/server/jobs/__tests__/blob-retraction-writer-reachability.test.ts`.
 *
 * 🔴 This file exists for the site that CANNOT share that helper: `apps/moderator` is a separate
 * SvelteKit app that does not import the main app's `src/`, so it re-declares the two key strings
 * — the same way it re-declares `BLOCKED_REASON_MODERATED`. A re-declared constant is a silent
 * drift surface: rename the key in `image-removal-mode.ts` and the main app keeps working while
 * the moderator app, which performs most blocks, quietly strips nothing at all. Nothing else in
 * either app would notice, because a metadata key that is never found reads exactly like a row
 * that never had one.
 *
 * The guard is on the SOURCE rather than on behaviour because the two apps do not share a test
 * runtime; what it can prove is that the literal in the block statement is the literal the main
 * app defines, and that the statement is still a strip.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MOD_BLOCK_FILE = 'apps/moderator/src/lib/server/image-moderation.service.ts';

function source(): string {
  return readFileSync(path.join(REPO_ROOT, MOD_BLOCK_FILE), 'utf8');
}

/**
 * The body of `blockImage`, bounded by the next top-level `export ` — so an occurrence in
 * `acceptImage` or in a comment elsewhere in the file cannot satisfy the claims below.
 */
function blockImageBody(src: string): string {
  const start = src.indexOf('export async function blockImage(');
  expect(start, `blockImage is no longer declared in ${MOD_BLOCK_FILE}`).toBeGreaterThan(-1);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

describe('the moderator app strips the same account-deletion breadcrumbs the main app writes', () => {
  // Positive control. Every claim below is a substring search; if the file moved or was renamed,
  // an empty read would satisfy the negative half and the rest would be vacuous.
  it('can read the moderator app block site', () => {
    expect(source().length, `${MOD_BLOCK_FILE} is empty or unreadable`).toBeGreaterThan(1000);
  });

  it('declares both keys with the values the main app defines', () => {
    const src = source();
    for (const key of [PRIOR_INGESTION_KEY, PRIOR_BLOCKED_FOR_KEY]) {
      expect(
        src.includes(`'${key}'`),
        `${MOD_BLOCK_FILE} does not carry the literal '${key}'. It re-declares these keys because ` +
          'it cannot import them; renaming one in image-removal-mode.ts means renaming it here too, ' +
          'or the moderator app silently stops clearing the breadcrumb.'
      ).toBe(true);
    }
  });

  it('strips both keys on the block write itself', () => {
    const body = blockImageBody(source());
    // The `-` operator, applied to both keys, inside the statement that sets `ingestion: 'Blocked'`.
    // Asserting the operator and not just the names is what separates "the block removes them"
    // from "the block happens to mention them".
    expect(body.includes("ingestion: 'Blocked'"), 'blockImage no longer blocks').toBe(true);
    expect(
      /"metadata"\s*-\s*\$\{ACCOUNT_DELETION_PRIOR_INGESTION_KEY\}::text\s*-\s*\$\{ACCOUNT_DELETION_PRIOR_BLOCKED_FOR_KEY\}::text/.test(
        body
      ),
      'the moderator app block no longer removes both breadcrumbs from metadata, so a later ' +
        'account restore can un-block content it hid'
    ).toBe(true);
  });
});
