import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'vitest';

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

/** Every `submittedBy: { select: { … } }` literal in the service, as normalised text. */
function submitterSelects(source: string): string[] {
  const out: string[] = [];
  const re = /submittedBy:\s*\{\s*select:\s*\{([^}]*)\}\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push(m[1].replace(/\s+/g, ' ').trim());
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
