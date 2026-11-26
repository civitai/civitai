import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';

// The moderator app answers over HTTP; the client captures `fetch` when it is built, so the stub
// goes in before the controller loads.
const REFUSAL = 'An image in this batch is withheld from you. Nothing was changed: 1.';
const fetchStub = vi.fn(
  async () => new Response(JSON.stringify({ message: REFUSAL }), { status: 403 })
);
vi.stubGlobal('fetch', fetchStub);

const { moderateImageHandler } = await import('~/server/controllers/image.controller');

const ctx = { user: { id: 2, isModerator: true }, req: { headers: {} } } as never;

// A refusal from the moderator app reaches the moderator as FORBIDDEN with its own words, which
// the badge shows.
describe('moderateImageHandler', () => {
  it('passes a 403 refusal through as FORBIDDEN with its message', async () => {
    const run = moderateImageHandler({ input: { ids: [1], reviewAction: 'unblock' }, ctx });
    await expect(run).rejects.toBeInstanceOf(TRPCError);
    await expect(run).rejects.toMatchObject({ code: 'FORBIDDEN', message: REFUSAL });
    expect(fetchStub).toHaveBeenCalledOnce();
  });
});
