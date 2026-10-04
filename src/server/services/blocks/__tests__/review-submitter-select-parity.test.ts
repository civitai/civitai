import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { stripCommentsAndStrings } from '../../../../../test/strip-comments';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { reviewUserChipSelect } from '~/server/selectors/review-user-chip.selector';

/**
 * THE SEAM BETWEEN EVERY MODERATOR REVIEW SURFACE'S USER CHIP.
 *
 * The `/apps/review` queue (on-site AND off-site rows, interleaved in ONE list), the
 * per-submission page, and the prior-versions modal all render the SAME `UserAvatar` for the
 * submitter and the reviewer. That component reads `username`, `image`, `deletedAt`,
 * `profilePicture` and `cosmetics` off whatever object it is handed — so the surfaces agree
 * only while their selects do.
 *
 * 🔴 THIS FILE USED TO BE A 230-LINE PARITY SCAN, AND DELETING THAT WAS THE FIX.
 *
 * The literal `{ id, username, deletedAt, image }` was spelled inline at NINE sites in
 * `publish-request.service.ts` plus one in `offsite-listing.service.ts`, and the scan existed
 * to assert the ten agreed. They did not: `deletedAt` reached the five `submittedBy` ones a
 * whole round before the four `reviewedBy` ones, and the off-site chip after both — so for a
 * while the queue rendered a closed account as `[deleted]` on an on-site row and as a live,
 * linked profile on the off-site row directly beneath. A predicate open-coded at ten sites is
 * typically wrong at most of them in the same direction, and a scan can only report that
 * after the fact.
 *
 * There is now ONE declaration — `reviewUserChipSelect` — so parity is an identity rather
 * than a text property. What survives is the smaller question the const cannot answer by
 * itself: does it still carry what the chip BRANCHES on, and has a NARROWER copy appeared?
 *
 * ⚠️ The scan is not "replaced by types". A Prisma select is structurally typed, so a
 * narrower literal is still assignable — nothing in the type system objects to someone
 * writing the four fields out again, minus one. That is what the third case checks.
 */

const SERVICE_FILES = [
  'src/server/services/blocks/publish-request.service.ts',
  'src/server/services/blocks/offsite-listing.service.ts',
] as const;

/**
 * Every object literal in a service that names `username: true`, as its brace-matched body.
 *
 * 🔴 ANCHORED ON THE FIELD, NOT ON A NAME OR A WRAPPER — and both narrower anchors were
 * measured walkable before this one.
 *
 * An allowlist of property names policed four identifiers against ~109 `select: {` sites
 * across these two files: hoisting the same narrower literal as `authorChip` and writing
 * `submittedBy: authorChip` left it green. Anchoring on `select: {` instead fixes the name
 * half and keeps a wrapper half — it misses `const modChip = { id: true, username: true,
 * image: true }`, a chip with no `select` of its own, which is the OTHER shape that has
 * existed here.
 *
 * Anchoring on the field cannot be walked by renaming or re-nesting anything: a select that
 * names `username` is a user chip, whatever it is called and wherever it sits, and on these
 * two services every user chip must carry `deletedAt`.
 */
function userChipSelects(source: string): string[] {
  const code = stripCommentsAndStrings(source);
  const out: string[] = [];
  for (const m of code.matchAll(/\busername\s*:\s*true\b/g)) {
    // Walk BACK to the enclosing `{`, counting depth so a nested literal cannot escape…
    let depth = 0;
    let open = -1;
    for (let i = (m.index ?? 0) - 1; i >= 0; i -= 1) {
      const ch = code[i];
      if (ch === '}') depth += 1;
      else if (ch === '{') {
        if (depth === 0) {
          open = i;
          break;
        }
        depth -= 1;
      }
    }
    if (open < 0) continue;
    // …and FORWARD to its match.
    depth = 1;
    let i = open + 1;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    if (depth !== 0) continue;
    out.push(
      code
        .slice(open + 1, i - 1)
        .replace(/\s+/g, ' ')
        .trim()
    );
  }
  return out;
}

/** Every flat object literal in a file — the walk's own liveness control. */
const objectLiterals = (source: string) =>
  (stripCommentsAndStrings(source).match(/\{[^{}]*\}/g) ?? []).length;

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
    // names it. The render itself is pinned in `ReviewSubmitterMeta.browser.test.tsx` and,
    // for both row kinds in one list, `UnifiedReviewList.deletedSubmitter.browser.test.tsx`.
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

  test('🔴 every user chip these services select carries `deletedAt` — whatever it is called', () => {
    // The failure this replaces the parity scan for: a narrower literal written out again at
    // a new call site. Prisma selects are structurally typed, so `{ id: true, username: true,
    // image: true }` is perfectly assignable — it just silently drops the branch.
    const offenders: string[] = [];
    for (const rel of SERVICE_FILES) {
      for (const body of userChipSelects(readFileSync(join(process.cwd(), rel), 'utf8'))) {
        if (!/\bdeletedAt\s*:\s*true\b/.test(body)) offenders.push(`${rel}: { ${body} }`);
      }
    }
    expect(
      offenders,
      'a user chip without `deletedAt` renders a closed account as a live, linked profile'
    ).toEqual([]);
  });

  test('🔴 POSITIVE CONTROL: the walk is live, it CAN catch, and it survives the stripper', () => {
    // Three reassuring zeros to disprove.
    //
    // (a) The walk reads real literals out of the real files. Deliberately NOT a count of
    // user chips — there are legitimately zero of those now, because every one reads the
    // shared const, so asserting a non-zero chip count would fail the moment the guard
    // started succeeding.
    for (const rel of SERVICE_FILES) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(objectLiterals(src), `${rel} must yield object literals`).toBeGreaterThan(5);
      expect(src, `${rel} must consume the shared select`).toContain('reviewUserChipSelect');
    }

    // (b) It CAN catch — otherwise the case above is a walk that may never have rejected
    // anything. All four shapes: the property form, a hoisted const WITH a `select` wrapper,
    // a hoisted const WITHOUT one, and a differently-named property.
    const bad = [
      'submittedBy: { select: { id: true, username: true, image: true } },',
      'const authorChip = { select: { id: true, username: true, image: true } } as const;',
      'const modChip = { id: true, username: true, image: true } as const;',
      'owner: { select: { id: true, username: true, image: true } },',
    ].join('\n');
    expect(userChipSelects(bad).filter((b) => !/deletedAt/.test(b))).toHaveLength(4);

    // (c) 🔴 RUN THE PLANTED STRINGS THROUGH THE STRIPPER, which the real assertion does and
    // an earlier control did not. `stripCommentsAndStrings` is documented as deliberately
    // biased toward removing TOO MUCH — safe, because over-stripping is supposed to turn a
    // caller RED. It cannot here: the subject is an ABSENCE, so over-stripping silently
    // empties the corpus and the guard passes. Measured — neutering the stripper to return
    // `''` left this file green with a real inline literal planted.
    expect(userChipSelects(stripCommentsAndStrings(bad))).toHaveLength(4);

    // …and prose is still not a query.
    const proseOnly = [
      '// submittedBy: { select: { id: true, username: true } }',
      'const doc = `select: { id: true, username: true }`;',
      'submittedBy: { select: { id: true, username: true, deletedAt: true, image: true } },',
    ].join('\n');
    expect(userChipSelects(proseOnly)).toHaveLength(1);
  });
});
