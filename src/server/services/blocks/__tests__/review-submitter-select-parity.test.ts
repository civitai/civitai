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
  'src/server/services/blocks/app-listing.service.ts',
] as const;

/**
 * User chips in the corpus that are DELIBERATELY narrow, each by `id` plus its reason.
 *
 * 🔴 AN EXEMPTION LEDGER, NOT A WIDER SCAN. `app-listing.service.ts` was added because this
 * change made it a third consumer of the shared chip — and a hardcoded two-file list standing
 * in for "every blocks service that selects a user chip" is exactly the kind of corpus that
 * drifts silently behind the code. But that file also carries chips that must NOT carry
 * `deletedAt`, so appending it without this ledger would turn the guard red on intended code,
 * and a permanently-red guard teaches everyone to ignore it.
 *
 * Each entry is the chip's OWNING PROPERTY plus why it is narrow. Adding one is a decision
 * someone has to write down; the equality below fails if an entry becomes stale, so an
 * exemption cannot outlive its reason either.
 */
const DELIBERATELY_NARROW: ReadonlyArray<{ owner: string; why: string }> = [
  {
    owner: 'user',
    why: "the moderation listings table's own creator cell — plain text, a different screen",
  },
  {
    owner: '<anonymous>',
    why: 'the collaborator-allowlist `user.findMany`, whose WHERE already filters `deletedAt: null` in SQL — the rows cannot be deleted accounts, so projecting the column would be dead weight',
  },
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
 * Anchoring on the field cannot be walked by renaming or re-nesting anything INSIDE THESE
 * TWO FILES: a select that names `username` is a user chip, whatever it is called and
 * wherever it sits in them. ⚠️ A chip IMPORTED from a third module is outside the corpus —
 * measured, a narrower `narrowChip` exported from the selector module and referenced here
 * leaves this suite green. The backstop there is a different instrument: `ReviewUserChip`'s
 * REQUIRED `deletedAt`, which fails `pnpm typecheck` with one error naming the call site.
 */
function ownedUserChips(source: string): Array<{ owner: string; body: string }> {
  const code = stripCommentsAndStrings(source);
  const out: Array<{ owner: string; body: string }> = [];
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
    const body = code
      .slice(open + 1, i - 1)
      .replace(/\s+/g, ' ')
      .trim();
    // The nearest identifier before the literal (skipping an intervening `select:` and
    // `{`), i.e. the property or const this chip hangs off — what an exemption names.
    const before = code.slice(Math.max(0, open - 120), open);
    // `select` is a wrapper, never the owner — `x: { select: { … } }` belongs to `x`.
    const owner = [...before.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*\{?\s*(?:select\s*:\s*)?$/g)]
      .map((m) => m[1])
      .filter((n) => n !== 'select')
      .pop();
    out.push({ owner: owner ?? '<anonymous>', body });
  }
  return out;
}

/** Just the bodies — for the controls, which do not care who owns them. */
const userChipSelects = (source: string) => ownedUserChips(source).map((c) => c.body);

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
    const matchedEntries = new Set<string>();
    for (const rel of SERVICE_FILES) {
      for (const { owner, body } of ownedUserChips(
        readFileSync(join(process.cwd(), rel), 'utf8')
      )) {
        if (/\bdeletedAt\s*:\s*true\b/.test(body)) continue;
        const entry = DELIBERATELY_NARROW.find((e) => e.owner === owner);
        if (entry) {
          matchedEntries.add(entry.owner);
          continue;
        }
        offenders.push(`${rel}: ${owner}: { ${body} }`);
      }
    }
    expect(
      offenders,
      'a user chip without `deletedAt` renders a closed account as a live, linked profile'
    ).toEqual([]);

    // 🔴 THE EXEMPTIONS ARE ASSERTED, NOT MERELY ALLOWED. An entry whose chip has since been
    // widened — or deleted — is a stale licence to be narrow, and nothing else would notice.
    // Matched BY ENTRY rather than by count, because one owner name can cover more than one
    // chip (`user` appears twice) and a count would then encode an incidental number.
    expect(
      [...matchedEntries].sort(),
      'every entry in DELIBERATELY_NARROW must still correspond to a narrow chip'
    ).toEqual(DELIBERATELY_NARROW.map((e) => e.owner).sort());
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

    // (c-0) 🔴 AND THE STRIPPER REACHES THE END OF THE REAL FILE. Controls (a) and (b) prove
    // it is not DEAD; neither proves it does not swallow everything after some line, which
    // would hide every chip in the tail of a 4,000-line service. Appending the planted
    // violations to the real source and still finding all four is what closes that class.
    for (const rel of SERVICE_FILES) {
      const realSrc = readFileSync(join(process.cwd(), rel), 'utf8');
      const baseline = userChipSelects(realSrc).filter((b) => !/deletedAt/.test(b)).length;
      expect(
        userChipSelects(`${realSrc}\n${bad}`).filter((b) => !/deletedAt/.test(b)).length - baseline,
        `the scan must still reach all four violations appended AFTER all of ${rel}`
      ).toBe(4);
    }

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
