import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Saving a showcase pick is the trust boundary: the hat id comes from the client. A hat the caller
 * does not hold, or one of another event, must be refused before anything is written.
 */

const { engine, settings, sync, showcase, creator } = vi.hoisted(() => ({
  engine: { getReadableScoredEvent: vi.fn(), assertPlayable: vi.fn() },
  settings: { patchUserSettings: vi.fn(), getUserSettings: vi.fn(async () => ({})) },
  sync: {
    syncRosterMembersWith: vi.fn(),
    rosterEvents: vi.fn(),
    defaultRosterSyncDeps: vi.fn(() => ({})),
    syncEventRosterMember: vi.fn(),
    ROSTER_SETTING: 'eventRosterOptIn',
    rosterTeam: vi.fn(),
  },
  showcase: {
    refreshShowcaseHats: vi.fn(),
    resolveShowcaseHatIds: vi.fn(async () => new Map([[5, 3]])),
    getShowcaseHatForUser: vi.fn(async (userId: number) => ({
      cosmeticId: 3,
      url: `${userId}.png`,
    })),
    SHOWCASE_EVENT: { name: 'birthday2026' },
    SHOWCASE_SETTING: 'eventShowcaseHat',
    SHOWCASE_OFF: 'off',
  },
  creator: { bustUserCreator: vi.fn() },
}));
vi.mock('~/server/events', () => ({ eventEngine: engine }));
vi.mock('~/server/events/points/roster-sync', () => sync);
vi.mock('~/server/events/showcase-hat', () => showcase);
vi.mock('~/server/services/user-creator.service', () => creator);
vi.mock('~/server/redis/caches', () => ({
  cosmeticCache: { fetch: vi.fn() },
  eventDecorationEntityCaches: {},
  publicContentCaches: {},
  refreshOwnedStickerCache: vi.fn(),
  userBasicCache: { fetch: vi.fn() },
  profilePictureCache: { fetch: vi.fn() },
}));
vi.mock('~/server/services/user.service', () => ({
  ...settings,
  cosmeticStatus: vi.fn(),
  getCosmeticsForUsers: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticDetail: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({ getEntityCoverImage: vi.fn() }));

const { getMyShowcaseHat, getMyShowcaseHatArt, setShowcaseHat } = await import(
  '~/server/services/event.service'
);

const user = { id: 5 };
const event = 'birthday2026';

beforeEach(() => {
  vi.clearAllMocks();
  engine.getReadableScoredEvent.mockResolvedValue({ name: event });
});

describe('setShowcaseHat', () => {
  it("refuses a hat the caller doesn't hold, and writes nothing", async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([] as never);
    await expect(setShowcaseHat({ event, cosmeticId: 3, user })).rejects.toThrow(
      "You don't have that hat"
    );
    expect(settings.patchUserSettings).not.toHaveBeenCalled();
    expect(showcase.refreshShowcaseHats).not.toHaveBeenCalled();
  });

  it('checks ownership against this user, this hat and this event', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ ok: 1 }] as never);
    await setShowcaseHat({ event, cosmeticId: 3, user });
    const values = dbMock.dbWrite.$queryRaw.mock.calls[0].slice(1);
    expect(values).toEqual([5, 3, event]);
  });

  it('saves a held hat, then refreshes every surface that shows it', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ ok: 1 }] as never);
    await setShowcaseHat({ event, cosmeticId: 3, user });
    expect(settings.patchUserSettings).toHaveBeenCalledWith(5, {
      mergeInto: { eventShowcaseHat: { [event]: 3 } },
      location: 'event.service:setShowcaseHat',
    });
    expect(showcase.refreshShowcaseHats).toHaveBeenCalledWith([5]);
    expect(creator.bustUserCreator).toHaveBeenCalledWith(5);
    expect(sync.syncEventRosterMember).toHaveBeenCalledWith(5, { event, onlyIfListed: true });
  });

  it('clears the pick without an ownership read', async () => {
    await setShowcaseHat({ event, cosmeticId: null, user });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(settings.patchUserSettings).toHaveBeenCalledWith(5, {
      mergeInto: { eventShowcaseHat: { [event]: null } },
      location: 'event.service:setShowcaseHat',
    });
  });

  it('turns the hat off without an ownership read, and refreshes the surfaces that show it', async () => {
    await setShowcaseHat({ event, off: true, user });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(settings.patchUserSettings).toHaveBeenCalledWith(5, {
      mergeInto: { eventShowcaseHat: { [event]: 'off' } },
      location: 'event.service:setShowcaseHat',
    });
    expect(showcase.refreshShowcaseHats).toHaveBeenCalledWith([5]);
    expect(creator.bustUserCreator).toHaveBeenCalledWith(5);
  });

  it('turns it back on as the default hat, not a remembered pick', async () => {
    await setShowcaseHat({ event, off: false, user });
    expect(settings.patchUserSettings).toHaveBeenCalledWith(5, {
      mergeInto: { eventShowcaseHat: { [event]: null } },
      location: 'event.service:setShowcaseHat',
    });
  });

  it('refuses an event without a showcase, and one the caller cannot play', async () => {
    await expect(setShowcaseHat({ event: 'holiday2024', cosmeticId: null, user })).rejects.toThrow(
      'This event has no showcase hat'
    );
    engine.assertPlayable.mockRejectedValueOnce(new Error('The event has ended'));
    await expect(setShowcaseHat({ event, cosmeticId: null, user })).rejects.toThrow('ended');
    expect(settings.patchUserSettings).not.toHaveBeenCalled();
  });
});

describe('getMyShowcaseHatArt', () => {
  it("returns the caller's showcase hat for the showcase event", async () => {
    expect(await getMyShowcaseHatArt({ event, user })).toEqual({ cosmeticId: 3, url: '5.png' });
    expect(showcase.getShowcaseHatForUser).toHaveBeenCalledWith(5);
  });

  // The team panels ask for every scored event; only the showcase event has a hat on show.
  it('returns no hat for any other event, without a lookup', async () => {
    expect(await getMyShowcaseHatArt({ event: 'holiday2025', user })).toBeNull();
    expect(showcase.getShowcaseHatForUser).not.toHaveBeenCalled();
  });
});

describe('getMyShowcaseHat', () => {
  it('reports off with no pick and no hat showing', async () => {
    settings.getUserSettings.mockResolvedValueOnce({
      eventShowcaseHat: { [event]: 'off' },
    } as never);
    showcase.resolveShowcaseHatIds.mockResolvedValueOnce(new Map());
    expect(await getMyShowcaseHat({ event, user })).toEqual({
      pick: null,
      showing: null,
      off: true,
    });
  });

  it('reports a pick as on', async () => {
    settings.getUserSettings.mockResolvedValueOnce({ eventShowcaseHat: { [event]: 3 } } as never);
    expect(await getMyShowcaseHat({ event, user })).toEqual({ pick: 3, showing: 3, off: false });
  });
});
