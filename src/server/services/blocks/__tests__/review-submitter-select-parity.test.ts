import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { stripCommentsAndStrings } from '../../../../../test/strip-comments';

/**
 * THE SEAM BETWEEN THE REVIEW QUEUE'S PAYLOAD AND THE REVIEW PAGE'S.
 *
 * The queue list and the per-submission page now render the SAME `UserAvatar` chip for the
 * submitter. That component reads `username`, `image`, `deletedAt`, `profilePicture` and
 * `cosmetics` off whatever object it is handed — so the two surfaces look identical only
 * while their `submittedBy` SELECTS agree. Measured at the time of writing: they do, to the
 * character, across all five readers.
 *
 * 🔴 AND `reviewedBy` IS THE SAME CHIP, WHICH THE FIRST VERSION OF THIS GUARD MISSED.
 * `PriorVersionsModal` renders BOTH through `UserAvatar`, side by side in one row — so a
 * `deletedAt` added to one and not the other means a deleted submitter is handled and a
 * deleted MODERATOR still renders as a live, linked account, in the same list. One rule,
 * one place: the cases below run over both keys.
 *
 * 🔴 NOTHING ELSE CAN SEE THIS. Each surface's own browser test renders its own fixture, so
 * widening one select (or narrowing another) leaves every one of them green while the two
 * screens start showing different things for one person — an avatar on the queue and
 * initials on the submission, or vice versa. The defect lives in the seam, which is exactly
 * where no component test looks.
 *
 * 🔴 WHY A SOURCE SCAN RATHER THAN A RUNTIME ASSERTION. These are Prisma `select` literals
 * inside five different functions; there is no exported value to compare. The alternative —
 * calling each function against a mocked client and diffing the recorded `select` — needs
 * five bespoke mock setups and would then assert what the mock was told, not what the five
 * literals say. The literal text IS the contract here.
 *
 * Deliberately NOT a "this exact field list" assertion: the list is allowed to grow (adding
 * `profilePicture` to every reader of a chip would be an improvement). What may never happen
 * is a chip's readers DISAGREEING with each other.
 */

const SERVICE_REL = 'src/server/services/blocks/publish-request.service.ts';

/**
 * Every `submittedBy: { select: … }` literal in the service, as normalised text.
 *
 * 🔴 A BRACE-COUNTING SCAN, NOT `[^}]*`. The lazy form cannot span a NESTED object, so the
 * moment anyone takes this file's own advice and adds `profilePicture: { select: { … } }`,
 * every capture truncates at the inner `}` — two selects identical up to that point and
 * divergent after it then compare EQUAL, the parity assertion passes, and so does the
 * ≥5 positive control. The guard would go quietly blind at exactly the edit it exists to
 * protect. (`test/component-setup.tsx` records the general version of this at length:
 * several regexes cannot agree about where a block ends.)
 *
 * 🔴 COMMENTS **AND STRING LITERALS** ARE STRIPPED FIRST, via the repo's shared
 * `stripCommentsAndStrings`. A commented-out `submittedBy: { select: { … } }` is not a
 * reader, and counting one would both inflate the positive control and let a stale shape
 * vote on parity. Strings are the same class one syntax over: this service builds raw SQL
 * and error copy, and a `submittedBy: { select: {` appearing inside a template literal is
 * documentation, not a query. `stripComments` alone — which is what this scan used first —
 * leaves that case counted. Nothing legitimate is lost: a real Prisma select is never
 * inside a quote.
 */
function chipSelects(source: string, key: ChipKey = 'submittedBy'): string[] {
  const code = stripCommentsAndStrings(source);
  const out: string[] = [];
  const opener = new RegExp(`${key}:\\s*\\{\\s*select:\\s*\\{`, 'g');
  let m: RegExpExecArray | null;
  while ((m = opener.exec(code)) !== null) {
    // Walk from just inside the `select: {` brace, counting depth, to its true match.
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    if (depth !== 0) continue; // unbalanced — not a literal we can read
    out.push(
      code
        .slice(start, i - 1)
        .replace(/\s+/g, ' ')
        .trim()
    );
    opener.lastIndex = i;
  }
  return out;
}

const source = readFileSync(join(process.cwd(), SERVICE_REL), 'utf8');

/**
 * The two user chips the moderator review reads, and what the scan must account for on each.
 *
 * `nonReaders` is an asserted LEDGER of every `<key>:` mention that is NOT a Prisma select —
 * see the positive control below for why a count cannot do this job.
 */
const CHIPS = [
  {
    // The three list builders (pending / approved / rejected), `listVersionHistory`, and the
    // page's single-request `getReviewRequestById`.
    key: 'submittedBy',
    floor: 5,
    // `ListingJoinSubject`'s TYPE annotation — it declares the request columns the
    // listing-ownership join reads rather than querying anything.
    nonReaders: ['{ id: number } | null'],
  },
  {
    // The three list builders and `listVersionHistory`. `getReviewRequestById` resolves the
    // reviewer separately, which is why this floor is one lower than the submitter's.
    key: 'reviewedBy',
    floor: 4,
    nonReaders: [] as string[],
  },
] as const;

type ChipKey = (typeof CHIPS)[number]['key'];

describe.each(CHIPS)('the moderator review surfaces agree about the $key payload', (chip) => {
  const { key, floor, nonReaders } = chip;

  test('🔴 POSITIVE CONTROL: the scan read EVERY mention in the service, not just the ones it could parse', () => {
    // Two claims, and the first is the one a hardcoded floor cannot make.
    //
    // 🔴 DERIVED, NOT A MAGIC 5 — and the measurement that says why. The control used to be
    // `parsed >= 5`, today's reader count. That does catch a reader CONVERTED to a shape the
    // scan cannot read (parsed drops to 4). What it cannot see is a reader ADDED in such a
    // shape: measured by mutation, inserting a sixth `submittedBy: SUBMITTER_SELECT` beside
    // the five leaves parsed at 5, so `>= 5` stays green while the new reader never votes on
    // parity. Hoisting the literal into a shared constant is the natural next refactor here,
    // which is exactly how that mutant gets written for real. So every `submittedBy:` MENTION
    // in the stripped source must be accounted for — a reader the scan cannot read is a
    // failure of the scan, and must say so rather than being quietly excluded.
    const code = stripCommentsAndStrings(source);
    const selects = chipSelects(source, key);

    // Every `submittedBy:` in the file, classified. One that the select scan did NOT parse
    // is kept as a short normalised snippet so it has to be ACCOUNTED FOR here rather than
    // silently excluded.
    const unparsed: string[] = [];
    const mention = new RegExp(`\\b${key}:`, 'g');
    let m: RegExpExecArray | null;
    let mentions = 0;
    while ((m = mention.exec(code)) !== null) {
      mentions += 1;
      const tail = code.slice(m.index + m[0].length, m.index + m[0].length + 60);
      if (/^\s*\{\s*select:\s*\{/.test(tail)) continue;
      // Cut at the statement terminator, or the window runs into the NEXT declaration and
      // the ledger entry changes whenever an unrelated line moves.
      unparsed.push(tail.split(';')[0].replace(/\s+/g, ' ').trim().slice(0, 40));
    }

    // 🔴 AN ASSERTED LEDGER OF THE NON-READERS, not a count. It fails when the set GROWS
    // (a reader written in a shape the scan cannot read — `submittedBy: SELECT`, or
    // `submittedBy: { select: { ...base } }`) and when it SHRINKS (the type named below
    // stops existing, so this entry is stale and nobody would otherwise notice).
    //
    // The one legitimate non-reader: the `ListingJoinSubject` TYPE annotation, which declares
    // the request columns the listing-ownership join reads rather than querying anything.
    expect(unparsed, `every \`${key}:\` is a parsed select or a known non-reader`).toEqual([
      ...nonReaders,
    ]);
    expect(
      selects.length,
      `the service mentions \`${key}:\` ${mentions} time(s), ${unparsed.length} of them accounted for as non-readers`
    ).toBe(mentions - unparsed.length);
    // …and an absolute floor, so a file that had lost every reader (or a scan matching
    // nothing at all) cannot satisfy the equality above with 0 === 0. The per-chip counts
    // are in `CHIPS` above.
    expect(selects.length).toBeGreaterThanOrEqual(floor);
  });

  test('🔴 every select for this chip in the service is IDENTICAL', () => {
    const selects = chipSelects(source, key);
    const distinct = [...new Set(selects)];
    // One assertion over the whole set, so a failure prints every variant rather than
    // stopping at the first pair.
    expect(distinct).toHaveLength(1);
  });

  test('…and it carries the fields the shared avatar chip actually BRANCHES on', () => {
    // `UserAvatar` falls back to initials from `username` and to `user.image` when there is
    // no `profilePicture` row, so those two plus `id` are the floor for the chip rendering at
    // all. `id` is additionally what the no-username branch shows (`#<id>`).
    //
    // 🔴 `deletedAt` IS REQUIRED, AND ITS ABSENCE WAS A LIVE DEFECT RATHER THAN A GAP.
    // `UserProfileLink` suppresses `linkToProfile` for a deleted account, and `Username`
    // renders "[deleted]" instead of a name — both read this field. Without it in the select
    // the value is `undefined` ⇒ falsy ⇒ a DELETED submitter rendered as a live, linked
    // account, on both the queue and the submission page. A field that exists in a DTO is not
    // a guard; this is the consumer that BRANCHES on it, which is why the floor names it.
    //
    // ⚠️ `profilePicture` is deliberately NOT required. It is the one remaining field
    // `UserAvatar` reads, but it is a NESTED select — a joined image row per row on three
    // list paths — for a cosmetic gain. Adding it later is still allowed (the parity rule is
    // that the readers AGREE, not what they contain), and the brace-counting scan above was
    // written specifically so that edit cannot blind this guard.
    const [select] = [...new Set(chipSelects(source, key))];
    for (const field of ['id: true', 'username: true', 'image: true', 'deletedAt: true']) {
      expect(select).toContain(field);
    }
  });
});

/**
 * THE SCANNER'S OWN CONTROLS — about `chipSelects`, not about either chip, so they run ONCE
 * rather than per chip. They are what make the parity assertions above readable as tests: a
 * scan that matched nothing, or truncated at a nested brace, would report agreement over an
 * empty or mangled set.
 */
describe('the select scanner', () => {
  test('🔴 NEGATIVE CONTROL: the comparison can actually fail', () => {
    // Proves the parity test is a test. Feed it two deliberately different literals and
    // watch the same derivation report a disagreement.
    const divergent = `
      submittedBy: { select: { id: true, username: true, image: true } }
      submittedBy: { select: { id: true, username: true, image: true, deletedAt: true } }
    `;
    expect(new Set(chipSelects(divergent)).size).toBe(2);
  });

  test('🔴 NEGATIVE CONTROL: it can still fail once a select carries a NESTED literal', () => {
    // The case the old `[^}]*` form went blind on, and the exact edit this file's docstring
    // invites. Both of these are identical up to the nested `profilePicture` and divergent
    // after it; a scan that truncated at the inner brace would call them equal.
    const nested = `
      submittedBy: { select: { id: true, profilePicture: { select: { url: true } }, image: true } }
      submittedBy: { select: { id: true, profilePicture: { select: { url: true } }, image: false } }
    `;
    const seen = chipSelects(nested);
    expect(seen, 'both nested literals are read whole').toHaveLength(2);
    expect(seen[0]).toContain('profilePicture');
    expect(new Set(seen).size, 'and they are told apart').toBe(2);
  });

  test('🔴 a COMMENTED-OUT or QUOTED select is not counted as a reader', () => {
    // Prose and copy are not queries. The quoted cases are why the scan upgraded from
    // `stripComments` to `stripCommentsAndStrings`: a select spelled inside a template
    // literal or an error string used to be counted, which both inflated the positive
    // control and let a shape nobody executes vote on parity.
    const commented = [
      '      // submittedBy: { select: { id: true } }',
      '      /* submittedBy: { select: { username: true } } */',
      '      const doc = `submittedBy: { select: { id: true, bogus: true } }`;',
      "      throw new Error('submittedBy: { select: { nope: true } }');",
      '      submittedBy: { select: { id: true, username: true, image: true } }',
    ].join('\n');
    const seen = chipSelects(commented);
    expect(seen).toHaveLength(1);
    // …and it is the LIVE one, not one of the four decoys.
    expect(seen[0]).toBe('id: true, username: true, image: true');
  });
});

