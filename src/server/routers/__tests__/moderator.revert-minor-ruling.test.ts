import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MinorHashService from '~/server/services/minor-hash.service';

const { mockRevert } = vi.hoisted(() => ({ mockRevert: vi.fn() }));
vi.mock('~/server/services/minor-hash.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MinorHashService>()),
  revertMinorHashAutoFlag: mockRevert,
}));

import { modRouter } from '~/server/routers/moderator';
import { TokenScope } from '~/shared/constants/token-scope.constants';

beforeEach(() => vi.clearAllMocks());

// A moderator's revert must hold against a rescan of the same text, which the ruling stamp does.
describe('mod.models.revertMinorHashAutoFlag', () => {
  it("records the moderator's text-scan ruling", async () => {
    const caller = modRouter.createCaller({
      user: { id: 7, isModerator: true },
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      apiKeyId: null,
      req: { headers: {} },
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      features: {},
      track: {},
    } as never);
    await caller.models.revertMinorHashAutoFlag({ id: 42 });
    expect(mockRevert).toHaveBeenCalledWith({
      modelId: 42,
      userId: 7,
      recordTextScanRuling: true,
    });
  });
});
