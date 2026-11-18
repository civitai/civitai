import { describe, expect, it } from 'vitest';
import { revokeAppBlockOauthTokens } from '~/server/services/blocks/app-block-token-revoke.service';

type Key = { id: number; clientId: string | null; type: string };

// An in-memory AppBlock + ApiKey pair that answers the three calls the helper makes, so the
// deletes are checked on rows, not on call shapes.
function store(blocks: Array<{ id: string; appId: string }>, keys: Key[]) {
  const tx = {
    appBlock: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        blocks.find((b) => b.id === where.id) ?? null,
      count: async ({ where }: { where: { appId: string; NOT: { id: string } } }) =>
        blocks.filter((b) => b.appId === where.appId && b.id !== where.NOT.id).length,
    },
    apiKey: {
      deleteMany: async ({ where }: { where: { clientId: string; type: { in: string[] } } }) => {
        const doomed = keys.filter(
          (k) => k.clientId === where.clientId && where.type.in.includes(k.type)
        );
        for (const k of doomed) keys.splice(keys.indexOf(k), 1);
        return { count: doomed.length };
      },
    },
  };
  return { tx: tx as never, keys };
}

describe('revokeAppBlockOauthTokens', () => {
  it("🔴 deletes the block's app tokens and nothing else", async () => {
    const { tx, keys } = store(
      [
        { id: 'apb_held', appId: 'appblk-held' },
        { id: 'apb_live', appId: 'appblk-live' },
      ],
      [
        { id: 1, clientId: 'appblk-held', type: 'Access' },
        { id: 2, clientId: 'appblk-held', type: 'Refresh' },
        { id: 3, clientId: 'appblk-live', type: 'Access' },
        { id: 4, clientId: null, type: 'User' },
      ]
    );
    expect(await revokeAppBlockOauthTokens(tx, 'apb_held')).toBe(2);
    expect(keys.map((k) => k.id)).toEqual([3, 4]);
  });

  it('leaves a client that backs other blocks alone', async () => {
    const { tx, keys } = store(
      [
        { id: 'apb_remix_1', appId: 'civitai-remix-apps' },
        { id: 'apb_remix_2', appId: 'civitai-remix-apps' },
      ],
      [{ id: 1, clientId: 'civitai-remix-apps', type: 'Access' }]
    );
    expect(await revokeAppBlockOauthTokens(tx, 'apb_remix_1')).toBe(0);
    expect(keys).toHaveLength(1);
  });

  it('a missing block deletes nothing', async () => {
    const { tx, keys } = store([], [{ id: 1, clientId: 'appblk-x', type: 'Access' }]);
    expect(await revokeAppBlockOauthTokens(tx, 'apb_gone')).toBe(0);
    expect(keys).toHaveLength(1);
  });
});
