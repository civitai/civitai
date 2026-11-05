import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { getClientSafeError } from '~/server/trpc/client-safe-error';
import { parseErrorRef } from '~/utils/feedback/errorRef';

// The toast finds the ref in the text the server wrote, so the two formats are pinned together:
// a reworded masked message makes every server-fault toast silently lose its "Report this".
describe('parseErrorRef', () => {
  it("reads the ref out of the server's own masked message", () => {
    const safe = getClientSafeError(new TRPCError({ code: 'INTERNAL_SERVER_ERROR' }));
    expect(safe).toBeDefined();
    expect(parseErrorRef(safe?.message)).toBe(safe?.errorRef);
  });

  it('finds nothing in a validation message', () => {
    expect(parseErrorRef('Images must be at least 256x256px.')).toBeUndefined();
  });
});
