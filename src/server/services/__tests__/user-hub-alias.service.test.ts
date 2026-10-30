import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type * as Blocklist from '~/server/services/blocklist.service';

// Its own file because of this mock. `user-hub.service.test.ts` runs the REAL scan over
// forty-odd upsert cases, and mocking the blocklist there would change the harness under
// all of them to test four.
const { blockedTextMock } = vi.hoisted(() => ({ blockedTextMock: vi.fn() }));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: blockedTextMock,
}));

import { upsertUserHub } from '~/server/services/user-hub.service';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

// A hub's own name is text the saver wrote and can fix, so a refusal there refuses the
// save. A source ALIAS is someone else's username or a stored model name, arriving by
// the dozen from a picker — so it loses the label and keeps the source. The two rules
// live one line apart and are easy to collapse into each other.

const create = dbMock.dbWrite.userHub.create;
const countHubs = dbMock.dbRead.userHub.count;

const refuse = (blocked: string) =>
  blockedTextMock.mockImplementation(async (content: unknown) => {
    const values = Array.isArray(content) ? content : [content];
    if (values.includes(blocked)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'blocked' });
  });

const save = (sources: { targetId: number; alias?: string | null }[], name = 'fine') =>
  upsertUserHub({
    name,
    sources: sources.map((source, index) => ({
      type: UserHubSourceType.User,
      targetId: source.targetId,
      alias: source.alias ?? null,
      enabled: true,
      index,
    })),
    userId: 5,
  });

beforeEach(() => {
  for (const mock of [create, countHubs]) mock.mockClear();
  blockedTextMock.mockReset();
  blockedTextMock.mockResolvedValue(undefined);
  countHubs.mockResolvedValue(0);
  create.mockResolvedValue({ id: 7, sources: [] });
});

describe('upsertUserHub alias scanning', () => {
  it('saves the hub, without the label the scan refused', async () => {
    refuse('refused');

    await save([
      { targetId: 3, alias: 'fine' },
      { targetId: 4, alias: 'refused' },
    ]);

    const written = create.mock.calls[0][0].data.sources.create;
    expect(
      written.map((source: { targetId: number; alias: string | null }) => source.alias)
    ).toEqual(['fine', null]);
  });

  it('still refuses the whole save when the hub NAME is the blocked text', async () => {
    // The negative control. Without it, "aliases do not refuse" is one edit away from
    // "nothing on this path refuses".
    refuse('badname');

    await expect(save([{ targetId: 3, alias: 'fine' }], 'badname')).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('raises a scan that could not run instead of stripping every label', async () => {
    // A Redis or replica blip throws from inside the scan. Read as a refusal, it would
    // null every alias on the list and report success — the control not running, and
    // nothing saying so.
    //
    // Only the ALIAS scan fails here. Rejecting every call instead would throw on the
    // hub's own name first — which has no try/catch at all — and the assertions below
    // would pass without `withoutBlockedAliases` ever running.
    blockedTextMock.mockImplementation(async (content: unknown) => {
      const values = Array.isArray(content) ? content : [content];
      if (values.includes('creator-a')) throw new Error('ECONNRESET');
    });

    await expect(save([{ targetId: 3, alias: 'creator-a' }], 'hub name')).rejects.toThrow(
      'ECONNRESET'
    );
    expect(create).not.toHaveBeenCalled();
    // The name scan, then the batch alias scan. A THIRD call would mean it fell through
    // to the per-alias pass and re-asked a scan it already knows is down.
    expect(blockedTextMock).toHaveBeenCalledTimes(2);
  });

  it('scans each alias on its own once the batch is refused', async () => {
    // The batch call names no offender, so a refusal there proves only that one of them
    // is bad. Keeping the whole list on that evidence is what the per-alias pass avoids.
    refuse('refused');

    await save([
      { targetId: 3, alias: 'fine' },
      { targetId: 4, alias: 'refused' },
      { targetId: 6, alias: 'also fine' },
    ]);

    const written = create.mock.calls[0][0].data.sources.create;
    expect(written).toHaveLength(3);
    expect(
      written.map((source: { targetId: number; alias: string | null }) => [
        source.targetId,
        source.alias,
      ])
    ).toEqual([
      [3, 'fine'],
      [4, null],
      [6, 'also fine'],
    ]);
  });
});
