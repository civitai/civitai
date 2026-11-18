import { describe, expect, it } from 'vitest';
import { revokeAppBlockOauthTokens } from '~/server/services/blocks/app-block-token-revoke.service';

type Block = { id: string; appId: string; status: string };
type Key = { id: number; clientId: string | null; type: string };

// An in-memory AppBlock + ApiKey pair that answers the three calls the helper makes, so the
// deletes are checked on rows, not on call shapes.
function store(blocks: Block[], keys: Key[]) {
  const tx = {
    appBlock: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        blocks.find((b) => b.id === where.id) ?? null,
      count: async ({ where }: { where: { appId: string; status: string; NOT: { id: string } } }) =>
        blocks.filter(
          (b) => b.appId === where.appId && b.status === where.status && b.id !== where.NOT.id
        ).length,
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
  it("🔴 deletes a suspended block's app tokens and nothing else", async () => {
    const { tx, keys } = store(
      [
        { id: 'apb_held', appId: 'appblk-held', status: 'suspended' },
        { id: 'apb_live', appId: 'appblk-live', status: 'approved' },
      ],
      [
        { id: 1, clientId: 'appblk-held', type: 'Access' },
        { id: 2, clientId: 'appblk-held', type: 'Refresh' },
        { id: 3, clientId: 'appblk-live', type: 'Access' },
        { id: 4, clientId: null, type: 'User' },
        { id: 5, clientId: 'appblk-held', type: 'User' },
      ]
    );
    expect(await revokeAppBlockOauthTokens(tx, 'apb_held')).toBe(2);
    expect(keys.map((k) => k.id)).toEqual([3, 4, 5]);
  });

  it('a block that does not read suspended (a drifted flip, a remix row) revokes nothing', async () => {
    for (const status of ['pending', 'deprecated', 'remix', 'remix_disabled', 'approved']) {
      const { tx, keys } = store(
        [{ id: 'apb_1', appId: 'client-1', status }],
        [{ id: 1, clientId: 'client-1', type: 'Access' }]
      );
      expect(await revokeAppBlockOauthTokens(tx, 'apb_1')).toBe(0);
      expect(keys).toHaveLength(1);
    }
  });

  it('a client with another block still approved keeps its tokens', async () => {
    const { tx, keys } = store(
      [
        { id: 'apb_a', appId: 'shared', status: 'suspended' },
        { id: 'apb_b', appId: 'shared', status: 'approved' },
      ],
      [{ id: 1, clientId: 'shared', type: 'Access' }]
    );
    expect(await revokeAppBlockOauthTokens(tx, 'apb_a')).toBe(0);
    expect(keys).toHaveLength(1);
  });

  it('🔴 once every block on a shared client is suspended, the tokens go', async () => {
    const { tx, keys } = store(
      [
        { id: 'apb_a', appId: 'shared', status: 'suspended' },
        { id: 'apb_b', appId: 'shared', status: 'suspended' },
      ],
      [{ id: 1, clientId: 'shared', type: 'Access' }]
    );
    expect(await revokeAppBlockOauthTokens(tx, 'apb_b')).toBe(1);
    expect(keys).toHaveLength(0);
  });

  it('a missing block deletes nothing', async () => {
    const { tx, keys } = store([], [{ id: 1, clientId: 'appblk-x', type: 'Access' }]);
    expect(await revokeAppBlockOauthTokens(tx, 'apb_gone')).toBe(0);
    expect(keys).toHaveLength(1);
  });
});
