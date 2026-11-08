import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_PREVIEW_FROM,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';

// Wholesale: the reads are injected below, and the real module pulls the whole event engine in.
vi.mock('~/server/services/event.service', () => ({
  getViewerEventAccess: vi.fn(),
  getEventCosmetic: vi.fn(),
}));

const { getEventSeeds } = await import('~/server/services/event-seeds.service');

type Args = Parameters<typeof getEventSeeds>[0];
const DURING = new Date(BIRTHDAY_2026_STARTS_AT.getTime() + 24 * 60 * 60 * 1000);
const BEFORE_RELEASE = new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() - 1);
const USER = { id: 42, isModerator: false } as unknown as NonNullable<Args['user']>;
// Distinct from every other value asserted, so a seed taken from the wrong read cannot pass.
const COSMETIC = {
  available: true,
  obtained: true,
  equipped: false,
  data: { n: 1 },
  cosmetic: null,
};

const getAccess = vi.fn<NonNullable<Args['getAccess']>>();
const getCosmetic = vi.fn<NonNullable<Args['getCosmetic']>>();
const seeds = (over: Partial<Args>) =>
  getEventSeeds({ user: USER, now: DURING, getAccess, getCosmetic, ...over });

beforeEach(() => {
  getAccess.mockReset().mockResolvedValue('open');
  getCosmetic.mockReset().mockResolvedValue(COSMETIC as never);
});

describe('getEventSeeds', () => {
  it('seeds the access and the cosmetic of a released decoration for a signed-in viewer', async () => {
    expect(await seeds({})).toEqual([
      { event: BIRTHDAY_2026_EVENT, access: 'open', cosmetic: COSMETIC },
    ]);
    expect(getAccess).toHaveBeenCalledWith({ event: BIRTHDAY_2026_EVENT, viewer: USER });
    expect(getCosmetic).toHaveBeenCalledWith({
      event: BIRTHDAY_2026_EVENT,
      user: { id: USER.id, isModerator: false },
    });
  });

  it('seeds the access alone for a signed-out viewer, as for tRPC with no user', async () => {
    getAccess.mockResolvedValue('preview');
    expect(await seeds({ user: undefined })).toEqual([
      { event: BIRTHDAY_2026_EVENT, access: 'preview' },
    ]);
    expect(getAccess).toHaveBeenCalledWith({ event: BIRTHDAY_2026_EVENT, viewer: undefined });
    expect(getCosmetic).not.toHaveBeenCalled();
  });

  it('reads a banned viewer as signed out, as tRPC does, and reads no cosmetic', async () => {
    const banned = { ...USER, bannedAt: new Date() } as unknown as NonNullable<Args['user']>;
    expect(await seeds({ user: banned })).toEqual([{ event: BIRTHDAY_2026_EVENT, access: 'open' }]);
    expect(getAccess).toHaveBeenCalledWith({ event: BIRTHDAY_2026_EVENT, viewer: undefined });
    expect(getCosmetic).not.toHaveBeenCalled();
  });

  it('reads no cosmetic where the viewer may not wear the decoration', async () => {
    getAccess.mockResolvedValue('closed');
    expect(await seeds({})).toEqual([{ event: BIRTHDAY_2026_EVENT, access: 'closed' }]);
    expect(getCosmetic).not.toHaveBeenCalled();
  });

  it('seeds nothing, and reads nothing, before any decoration is released', async () => {
    expect(await seeds({ now: BEFORE_RELEASE })).toEqual([]);
    expect(getAccess).not.toHaveBeenCalled();
  });

  it('leaves out an event whose access read fails, so the client fetches it', async () => {
    getAccess.mockRejectedValue(new Error('flipt down'));
    expect(await seeds({})).toEqual([]);
    expect(getCosmetic).not.toHaveBeenCalled();
  });

  it('keeps the access when only the cosmetic read fails', async () => {
    getCosmetic.mockRejectedValue(new Error('redis down'));
    expect(await seeds({})).toEqual([{ event: BIRTHDAY_2026_EVENT, access: 'open' }]);
  });
});
