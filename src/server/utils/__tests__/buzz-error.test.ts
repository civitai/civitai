import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';

describe('getBuzzApiStatus', () => {
  it('reads the status straight off a raw BuzzApiError', () => {
    expect(getBuzzApiStatus(new BuzzApiError(409, 'Conflict'))).toBe(409);
  });

  // The shape callers actually see: buzz.service's mapError converts every non-2xx into a
  // TRPCError and carries the original as `cause`.
  it('recovers the status through the TRPCError mapError produces', () => {
    const mapped = new TRPCError({
      code: 'BAD_REQUEST',
      message: 'There is a conflict with the transaction',
      cause: new BuzzApiError(409, 'Conflict'),
    });
    expect(getBuzzApiStatus(mapped)).toBe(409);
  });

  it('reports undefined for anything that did not come from the buzz service', () => {
    expect(getBuzzApiStatus(new TRPCError({ code: 'BAD_REQUEST', message: 'nope' }))).toBeUndefined();
    expect(
      getBuzzApiStatus(new TRPCError({ code: 'BAD_REQUEST', cause: new Error('boom') }))
    ).toBeUndefined();
    expect(getBuzzApiStatus(new Error('boom'))).toBeUndefined();
    expect(getBuzzApiStatus(null)).toBeUndefined();
    expect(getBuzzApiStatus({ status: 409 })).toBeUndefined();
  });
});
