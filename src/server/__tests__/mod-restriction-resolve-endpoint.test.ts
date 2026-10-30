import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as z from 'zod';

const { resolveUserRestriction } = vi.hoisted(() => ({ resolveUserRestriction: vi.fn() }));

// The wrapper's auth, rate limit and parsing have their own suite; this one is about the definition.
vi.mock('~/server/utils/moderator-endpoint', () => ({
  defineModeratorEndpoint: (_name: string, def: unknown) => def,
}));
vi.mock('~/server/services/user-restriction-resolve.service', () => ({ resolveUserRestriction }));

type Def = {
  input: z.ZodType;
  handler: (input: unknown, ctx: { actor: { id: number } }) => Promise<unknown>;
};

const { default: endpoint } = (await import('~/pages/api/mod/restriction/resolve')) as unknown as {
  default: Def;
};

const call = (body: Record<string, unknown>) =>
  endpoint.handler(endpoint.input.parse({ userRestrictionId: 5, ...body }), { actor: { id: 9 } });

beforeEach(() => {
  resolveUserRestriction.mockReset();
  resolveUserRestriction.mockResolvedValue({ userId: 42 });
});

describe('/api/mod/restriction/resolve — ruling reason', () => {
  it('forwards a reason that belongs to the verdict, with its note', async () => {
    await call({ status: 'Upheld', resolvedReason: 'clear-intent', internalNotes: 'seen before' });

    expect(resolveUserRestriction).toHaveBeenCalledExactlyOnceWith({
      userRestrictionId: 5,
      status: 'Upheld',
      resolvedMessage: undefined,
      resolvedReason: 'clear-intent',
      internalNotes: 'seen before',
      moderatorId: 9,
    });
  });

  it.each([
    [
      'a reason from the other verdict',
      { status: 'Overturned', resolvedReason: 'clear-intent' },
      /not a reason for Overturned/,
    ],
    [
      'an appeal reason',
      { status: 'Upheld', resolvedReason: 'violation-confirmed' },
      /not a reason for Upheld/,
    ],
    [
      'Other with no note',
      { status: 'Upheld', resolvedReason: 'other' },
      /note when the reason is Other/,
    ],
  ])('refuses %s without ruling', async (_label, body, message) => {
    await expect(call(body)).rejects.toThrow(message);
    expect(resolveUserRestriction).not.toHaveBeenCalled();
  });

  // The wrapper turns a TRPCError into its own status and message; any other throw becomes a 500 and
  // the moderator never sees why.
  it('refuses as a 400, not as a server fault', async () => {
    const error = await call({ status: 'Overturned', resolvedReason: 'clear-intent' }).catch(
      (e) => e
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('BAD_REQUEST');
  });

  it('accepts Other with a note', async () => {
    await call({ status: 'Upheld', resolvedReason: 'other', internalNotes: 'alt account' });

    expect(resolveUserRestriction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ resolvedReason: 'other', internalNotes: 'alt account' })
    );
  });

  // Older callers (the tRPC router's clients, scripts) send no reason and must keep working.
  it.each([
    ['no reason field', {}],
    ['a blank reason', { resolvedReason: '  ' }],
  ])('still rules with %s, recording none', async (_label, body) => {
    await call({ status: 'Overturned', ...body });

    expect(resolveUserRestriction).toHaveBeenCalledTimes(1);
    expect(resolveUserRestriction.mock.calls[0][0].resolvedReason).toBeUndefined();
  });
});
