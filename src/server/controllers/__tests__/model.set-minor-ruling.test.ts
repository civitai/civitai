import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModelService from '~/server/services/model.service';

const { mockSetModelMinor } = vi.hoisted(() => ({ mockSetModelMinor: vi.fn() }));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  setModelMinor: mockSetModelMinor,
}));

import { setModelMinorHandler } from '~/server/controllers/model.controller';

beforeEach(() => vi.clearAllMocks());

// A moderator's Unset must hold against a rescan of the same text, which the ruling stamp does.
describe('setModelMinorHandler', () => {
  it("records the moderator's text-scan ruling", async () => {
    await setModelMinorHandler({
      input: { id: 42, minor: false },
      ctx: { user: { id: 7, isModerator: true }, track: {} },
    } as never);
    expect(mockSetModelMinor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, minor: false, userId: 7, recordTextScanRuling: true })
    );
  });
});
