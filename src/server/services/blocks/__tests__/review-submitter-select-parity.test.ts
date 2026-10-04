import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { stripCommentsAndStrings } from '../../../../../test/strip-comments';
import { reviewUserChipSelect, simpleUserSelect } from '~/server/selectors/user.selector';

/**
 * THE SEAM BETWEEN EVERY MODERATOR REVIEW SURFACE'S USER CHIP.
 *
 * The `/apps/review` queue (on-site AND off-site rows, interleaved in ONE list), the
 * per-submission page, and the prior-versions modal all render the SAME `UserAvatar` for the
 * submitter and the reviewer. That component reads `username`, `image`, `deletedAt`,
 * `profilePicture` and `cosmetics` off whatever object it is handed — so the surfaces agree
 * only while their selects do.
 *
 * 🔴 THIS FILE USED TO BE A 230-LINE SOURCE SCAN, AND DELETING IT WAS THE FIX.
 *
 * The literal `{ id, username, deletedAt, image }` was spelled inline at NINE sites in
 * `publish-request.service.ts` plus one in `offsite-listing.service.ts`, and the scan existed
 * to assert the ten agreed. They did not: `deletedAt` reached the five `submittedBy` ones a
 * whole round before the four `reviewedBy` ones, and the off-site chip after both — so for a
 * while the queue rendered a closed account as `[deleted]` on an on-site row and as a live,
 * linked profile on the off-site row directly beneath. A predicate open-coded at ten sites is
 * typically wrong at most of them in the same direction, and a scan can only ever report that
 * after the fact.
 *
 * There is now ONE declaration — `reviewUserChipSelect` — so parity is an identity rather
 * than a text property, and the scan's whole subject is gone. What survives is the smaller
 * question the const cannot answer by itself: does it still carry the fields the chip
 * BRANCHES on, and has anyone re-introduced an inline copy?
 *
 * ⚠️ The scan is not "replaced by types". A Prisma select is structurally typed, so a
 * NARROWER inline literal is still assignable — nothing in the type system objects to
 * someone writing the four fields out again, minus one. That is what the third case checks.
 */

const SERVICE_FILES = [
  'src/server/services/blocks/publish-request.service.ts',
  'src/server/services/blocks/offsite-listing.service.ts',
] as const;

/**
 * An inline `{ select: { … } }` literal on any of the chip-bearing names.
 *
 * `[:=]` covers both spellings that have existed here: the property form
 * (`submittedBy: { select: { … } }`) and the hoisted-const form
 * (`const submitterChip = { select: { … } }`), which is how the off-site service wrote it.
 * A site that reads the shared const has no `{` after `select:` and cannot match.
 */
const INLINE_CHIP = /(submittedBy|reviewedBy|submitter(?:Chip)?)\s*[:=]\s*\{\s*select\s*:\s*\{/g;

describe('the review user chip is one declaration', () => {
  test('🔴 it carries the fields `UserAvatar` actually BRANCHES on', () => {
    // `UserAvatar` falls back to initials from `username` and to `user.image` when there is
    // no `profilePicture` row, so those two plus `id` are the floor for the chip rendering at
    // all. `id` is additionally what the no-username branch shows (`#<id>`).
    //
    // 🔴 `deletedAt` IS REQUIRED, AND ITS ABSENCE WAS A LIVE DEFECT RATHER THAN A GAP.
    // `UserProfileLink` suppresses `linkToProfile` for a deleted account, and `Username`
    // renders "[deleted]" instead of a name — both read this field. Without it the value is
    // `undefined` ⇒ falsy ⇒ a DELETED submitter rendered as a live, linked account, on the
    // surface where who submitted a bundle is the fact being judged. A field that exists in a
    // DTO is not a guard; those are the consumers that BRANCH on it, which is why the floor
    // names it. The render itself is pinned in `ReviewSubmitterMeta.browser.test.tsx`.
    expect(reviewUserChipSelect).toEqual({
      id: true,
      username: true,
      deletedAt: true,
      image: true,
    });
  });

  test('🔴 it is `simpleUserSelect` MINUS `profilePicture` — an asserted relationship, not a coincidence', () => {
    // The repo's house chip is `simpleUserSelect`, and this one is deliberately one field
    // narrower: `profilePicture` is a NESTED select, so Prisma issues an extra batched query
    // against one of the largest tables in the database per list call — on three mod-queue
    // list paths, for a gain `UserAvatar` already falls back from.
    //
    // 🔴 ASSERTED RATHER THAN DERIVED. Writing `const { profilePicture, ...rest } =
    // simpleUserSelect` in the SOURCE would make a new field on the house chip propagate here
    // silently, onto exactly those list paths. Asserting it instead means a widening of
    // `simpleUserSelect` turns this case RED and forces someone to decide. That is the point.
    const { profilePicture, ...rest } = simpleUserSelect;
    expect(
      profilePicture,
      'the field this chip exists to omit must still be on the house chip'
    ).toBeDefined();
    expect(rest).toEqual(reviewUserChipSelect);
  });

  test('🔴 no service re-introduces an INLINE chip literal — the type system cannot see one', () => {
    // The failure this replaces the old scan for: a narrower literal written out again at a
    // new call site. Prisma selects are structurally typed, so `{ id: true, username: true,
    // image: true }` is perfectly assignable — it just silently drops the branch.
    //
    // Comments and strings are stripped first: a select spelled in a docstring or an error
    // message is prose, not a query, and counting one would fail this for no reason.
    const offenders: string[] = [];
    for (const rel of SERVICE_FILES) {
      const code = stripCommentsAndStrings(readFileSync(join(process.cwd(), rel), 'utf8'));
      for (const m of code.matchAll(INLINE_CHIP)) {
        offenders.push(`${rel}: ${m[0].replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders, 'every review user chip must read `reviewUserChipSelect`').toEqual([]);
  });

  test('🔴 POSITIVE CONTROL: the services DO reference the shared const, and the pattern CAN match', () => {
    // Two reassuring zeros to disprove. (a) An empty `offenders` above is indistinguishable
    // from a scan pointed at the wrong files, so prove both services actually name the const.
    // (b) Prove the pattern matches when an inline literal IS present — otherwise the case
    // above is a regex that may never have matched anything in its life.
    for (const rel of SERVICE_FILES) {
      const code = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(code, `${rel} must consume the shared select`).toContain('reviewUserChipSelect');
    }
    const planted = [
      'submittedBy: { select: { id: true, username: true, image: true } },',
      'reviewedBy: { select: { id: true } },',
      'const submitterChip = { select: { id: true } } as const;',
    ];
    for (const p of planted) {
      expect(
        new RegExp(INLINE_CHIP.source).test(p),
        `the inline-literal pattern must match \`${p}\``
      ).toBe(true);
    }
  });
});
