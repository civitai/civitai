import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as S3Utils from '~/utils/s3-utils';

/** The vault listing signs no cover image of a taken-down model except for moderators. */

const h = vi.hoisted(() => ({ getGetUrlByKey: vi.fn() }));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getGetUrlByKey: h.getGetUrlByKey,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { vaultRouter } from '~/server/routers/vault.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const caller = (isModerator = false) =>
  vaultRouter.createCaller({
    user: { id: 4242, isModerator },
    ip: '1.2.3.4',
    features: {},
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
  } as never);

const item = (id: number, modelId: number) => ({
  id,
  vaultId: 4242,
  modelId,
  modelVersionId: id * 10,
  status: 'Stored',
  files: [],
});

type Model = { id: number; mode: string | null };
// The model's mode comes back only when the read selects it, as in prod.
const givenModels = (models: Model[]) =>
  dbMock.dbRead.model.findMany.mockImplementation((async (args: {
    where: { id: { in: number[] } };
    select?: { mode?: boolean };
  }) =>
    models
      .filter((model) => args.where.id.in.includes(model.id))
      .map((model) => (args.select?.mode ? model : { id: model.id }))) as never);

const covers = async (isModerator = false) => {
  const { items } = await caller(isModerator).getItemsPaged({ page: 1, limit: 10 });
  return Object.fromEntries(items.map((row) => [row.modelId, row.coverImageUrl]));
};

describe('vault.getItemsPaged — a taken-down model’s cover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({ S3_VAULT_BUCKET: 'vault-bucket' });
    dbMock.dbRead.vaultItem.findMany.mockResolvedValue([item(1, 100), item(2, 200)] as never);
    dbMock.dbRead.vaultItem.count.mockResolvedValue(2 as never);
    h.getGetUrlByKey.mockImplementation(async (key: string) => ({
      url: `https://example.invalid/${key}`,
    }));
    givenModels([
      { id: 100, mode: 'TakenDown' },
      { id: 200, mode: null },
    ]);
  });

  it("signs no cover for the vault's owner, and keeps the others", async () => {
    expect(await covers()).toEqual({ 100: null, 200: 'https://example.invalid/20/4242/cover.jpg' });
    expect(h.getGetUrlByKey).not.toHaveBeenCalledWith(
      expect.stringContaining('10/4242/'),
      expect.anything()
    );
  });

  it('still signs it for a moderator', async () => {
    expect(await covers(true)).toEqual({
      100: 'https://example.invalid/10/4242/cover.jpg',
      200: 'https://example.invalid/20/4242/cover.jpg',
    });
  });
});
