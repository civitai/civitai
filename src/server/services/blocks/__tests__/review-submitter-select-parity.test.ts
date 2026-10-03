import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { stripComments } from '../../../../../test/strip-comments';

/**
 * THE SEAM BETWEEN THE REVIEW QUEUE'S PAYLOAD AND THE REVIEW PAGE'S.
 *
 * The queue list and the per-submission page now render the SAME `UserAvatar` chip for the
 * submitter. That component reads `username`, `image`, `deletedAt`, `profilePicture` and
 * `cosmetics` off whatever object it is handed — so the two surfaces look identical only
 * while their `submittedBy` SELECTS agree. Measured at the time of writing: they do, to the
 * character, across all five readers.
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
 * `deletedAt` + `profilePicture` to all five would be an improvement). What may never
 * happen is the five DISAGREEING.
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
 * 🔴 COMMENTS ARE STRIPPED FIRST, via the repo's shared `stripComments`. A commented-out
 * `submittedBy: { select: { … } }` is not a reader, and counting one would both inflate the
 * positive control and let a stale shape vote on parity.
 */
function submitterSelects(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  const opener = /submittedBy:\s*\{\s*select:\s*\{/g;
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

describe('the moderator review surfaces agree about the submitter payload', () => {
  test('🔴 POSITIVE CONTROL: the scan found the selects at all', () => {
    // A regex that matched nothing would make the parity assertion below trivially true —
    // the reassuring-zero failure. The floor is 5 because that is what exists today: the
    // three list builders (pending / approved / rejected), `listVersionHistory`, and the
    // page's single-request `getReviewRequestById`.
    const selects = submitterSelects(source);
    expect(selects.length).toBeGreaterThanOrEqual(5);
  });

  test('🔴 NEGATIVE CONTROL: the comparison can actually fail', () => {
    // Proves the parity test is a test. Feed it two deliberately different literals and
    // watch the same derivation report a disagreement.
    const divergent = `
      submittedBy: { select: { id: true, username: true, image: true } }
      submittedBy: { select: { id: true, username: true, image: true, deletedAt: true } }
    `;
    expect(new Set(submitterSelects(divergent)).size).toBe(2);
  });

  test('🔴 NEGATIVE CONTROL: it can still fail once a select carries a NESTED literal', () => {
    // The case the old `[^}]*` form went blind on, and the exact edit this file's docstring
    // invites. Both of these are identical up to the nested `profilePicture` and divergent
    // after it; a scan that truncated at the inner brace would call them equal.
    const nested = `
      submittedBy: { select: { id: true, profilePicture: { select: { url: true } }, image: true } }
      submittedBy: { select: { id: true, profilePicture: { select: { url: true } }, image: false } }
    `;
    const seen = submitterSelects(nested);
    expect(seen, 'both nested literals are read whole').toHaveLength(2);
    expect(seen[0]).toContain('profilePicture');
    expect(new Set(seen).size, 'and they are told apart').toBe(2);
  });

  test('🔴 a COMMENTED-OUT select is not counted as a reader', () => {
    const commented = `
      // submittedBy: { select: { id: true } }
      /* submittedBy: { select: { username: true } } */
      submittedBy: { select: { id: true, username: true, image: true } }
    `;
    expect(submitterSelects(commented)).toHaveLength(1);
  });

  test('🔴 every `submittedBy` select in the service is IDENTICAL', () => {
    const selects = submitterSelects(source);
    const distinct = [...new Set(selects)];
    // One assertion over the whole set, so a failure prints every variant rather than
    // stopping at the first pair.
    expect(distinct).toHaveLength(1);
  });

  test('…and it carries the three fields the shared avatar chip needs to render a name', () => {
    // `UserAvatar` falls back to initials from `username` and to `user.image` when there is
    // no `profilePicture` row, so these three are the floor for the chip rendering at all.
    // `id` is additionally what the no-username branch shows (`#<id>`).
    const [select] = [...new Set(submitterSelects(source))];
    for (const field of ['id: true', 'username: true', 'image: true']) {
      expect(select).toContain(field);
    }
  });
});
