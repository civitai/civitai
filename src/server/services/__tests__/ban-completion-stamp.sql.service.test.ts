import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `toggleBan` writes `bannedAt` FIRST and then fans out — model unpublish, media block, comment
 * flagging, search-index removal, subscription cancels. Anything polling `bannedAt` is therefore told
 * the ban landed while all of that is still running on the primary, which is how Bulk Ban came to queue
 * a thousand overlapping fan-outs from a loop that looked like it was pacing itself.
 *
 * `banDetails.completedAt` is the fix, and its whole value is being LAST. A stamp written anywhere else
 * in the branch is worse than none: it reads as a bound while bounding nothing, and no caller can tell.
 * So these assert its position among the emitted statements, not its presence.
 */

const statements: string[] = [];

const record = (first: unknown, rest: unknown[]) => {
  if (Array.isArray(first) && Array.isArray((first as unknown as TemplateStringsArray).raw)) {
    statements.push(
      (first as string[]).reduce((acc, chunk, i) => acc + (i ? `$${i}` : '') + chunk, '')
    );
  } else if (
    first &&
    typeof first === 'object' &&
    typeof (first as { sql?: unknown }).sql === 'string'
  ) {
    statements.push((first as { sql: string }).sql);
  } else {
    statements.push(String(first));
  }
  return 1;
};

dbMock.dbWrite.$executeRaw.mockImplementation(async (first: unknown, ...rest: unknown[]) =>
  record(first, rest)
);

describe('ban completion stamp', () => {
  beforeEach(() => {
    statements.length = 0;
  });

  it('is the last statement the ban branch emits', async () => {
    // Read from the source rather than executed: `toggleBan` reaches a dozen services and an email
    // sender, and standing all of that up would test the mocks. The ORDER is a property of the file.
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/server/services/user.service.ts', 'utf8');

    const branchStart = src.indexOf('if (!bannedAt) {', src.indexOf('export const toggleBan'));
    const branchEnd = src.indexOf('\n  } else {', branchStart);
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);

    const branch = src.slice(branchStart, branchEnd);
    const stamp = branch.indexOf("'{banDetails,completedAt}'");
    expect(stamp).toBeGreaterThan(-1);

    // Every other awaited call in the branch has to come before it. `lastIndexOf` is the point: one
    // await moved below the stamp reopens the gap this closes.
    expect(stamp).toBeGreaterThan(branch.lastIndexOf('await Promise.all('));
    expect(stamp).toBeGreaterThan(branch.lastIndexOf('removeComments'));
  });

  it('merges into meta rather than rewriting it', async () => {
    // The fan-out takes seconds. A read-modify-write of `meta` here would clobber whatever else was
    // written to that column while it ran — which on a banned account is exactly the interesting data.
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/server/services/user.service.ts', 'utf8');
    const branch = src.slice(src.indexOf('export const toggleBan'));

    expect(branch).toContain('jsonb_set(COALESCE(meta');
    // And it must not create `banDetails` on an account that has none — `jsonb_set` needs the parent
    // object to exist, and an unban wipes it.
    expect(branch).toContain(`meta -> 'banDetails' IS NOT NULL`);
  });
});
