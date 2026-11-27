import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NsfwLevel } from '~/server/common/enums';

/**
 * The redesign's members-only page customisation: who may set it, what a visitor is shown, and
 * "Set as background". Membership is read from the subscription and override tables, so these
 * answer from those rows.
 */

const { assertPageCustomizationAllowed, getProfileCustomization, setProfileBackground } =
  await import('~/server/services/profile-customization.service');

const OWNER = 5;
const VISITOR = 6;

const subscription = (tier: string, status = 'active') => ({
  id: 's1',
  status,
  metadata: null,
  buzzType: 'yellow',
  product: { id: 'p', name: 'p', description: null, metadata: { tier }, provider: 'Civitai' },
  price: { id: 'pr', unitAmount: 1000, interval: 'month', currency: 'usd', active: true },
});

let subscriptions: ReturnType<typeof subscription>[];
let override: { tier: string } | null;

const scannedImage = (nsfwLevel: number, over: Record<string, unknown> = {}) => ({
  id: 70,
  url: 'bg.jpg',
  type: 'image',
  hash: 'h',
  width: 1,
  height: 1,
  nsfwLevel,
  ingestion: 'Scanned',
  needsReview: null,
  modelRestricted: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // A cold member cache: visitors' reads fall through to the tables below.
  redisMock.redis.packed.get.mockResolvedValue(null as never);
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true as never);
  subscriptions = [];
  override = null;
  dbMock.dbWrite.customerSubscription.findMany.mockImplementation(
    (async () => subscriptions) as never
  );
  dbMock.dbWrite.userMembershipOverride.findUnique.mockImplementation(
    (async () => override) as never
  );
  dbMock.dbWrite.userProfile.findUnique.mockResolvedValue({
    backgroundImageId: null,
    sfwBackgroundImageId: null,
    pageTheme: null,
  } as never);
});

describe('assertPageCustomizationAllowed', () => {
  const save = (input: Record<string, unknown>, profileRedesign = true) =>
    assertPageCustomizationAllowed({ userId: OWNER, profileRedesign, ...input });

  it('refuses a non-member setting a colour, opacity or background', async () => {
    await expect(save({ pageTheme: { dark: { color: '#112233' } } })).rejects.toThrow(
      /for members/
    );
    await expect(save({ backgroundImage: { url: 'new.jpg' } })).rejects.toThrow(/for members/);
  });

  it('treats the sidebar colour as members-only too', async () => {
    await expect(save({ pageTheme: { sidebar: { color: '#1b2a4a' } } })).rejects.toThrow(
      /for members/
    );
  });

  it('treats the light-mode colour and opacity as members-only too', async () => {
    await expect(save({ pageTheme: { light: { color: '#f3ead7', opacity: 90 } } })).rejects.toThrow(
      /for members/
    );
  });

  it('lets a paying member, and a comped member, set them', async () => {
    subscriptions = [subscription('gold')];
    await expect(
      save({ pageTheme: { dark: { color: '#112233', opacity: 70 } } })
    ).resolves.toBeUndefined();
    subscriptions = [];
    override = { tier: 'silver' };
    await expect(
      save({ pageTheme: { dark: { color: '#112233', opacity: 70 } } })
    ).resolves.toBeUndefined();
  });

  it('does not count a free override as a membership', async () => {
    override = { tier: 'free' };
    await expect(save({ pageTheme: { dark: { color: '#112233', opacity: 70 } } })).rejects.toThrow(
      /for members/
    );
  });

  it('lets a lapsed member re-save the values they already have, and clear them', async () => {
    dbMock.dbWrite.userProfile.findUnique.mockResolvedValue({
      backgroundImageId: 70,
      sfwBackgroundImageId: null,
      pageTheme: { dark: { color: '#112233', opacity: 70 } },
    } as never);
    await expect(
      save({
        pageTheme: { dark: { color: '#112233', opacity: 70 } },
        backgroundImage: { id: 70, url: 'bg.jpg' },
      })
    ).resolves.toBeUndefined();
    await expect(save({ pageTheme: null, backgroundImage: null })).resolves.toBeUndefined();
    // Only the opacity changes: still a new setting.
    await expect(save({ pageTheme: { dark: { color: '#112233', opacity: 90 } } })).rejects.toThrow(
      /for members/
    );
    await expect(save({ pageTheme: { dark: { color: '#445566', opacity: 70 } } })).rejects.toThrow(
      /for members/
    );
  });

  it('refuses any redesign field without the flag, and passes a save that touches none', async () => {
    subscriptions = [subscription('gold')];
    await expect(save({ about: '<p>hi</p>' }, false)).rejects.toThrow(/not available/);
    await expect(save({}, false)).resolves.toBeUndefined();
  });
});

describe('getProfileCustomization', () => {
  // Visitors read the replica, the owner the primary; both answer from the same row here.
  const stored = (over: Record<string, unknown> = {}) => {
    const row = {
      backgroundImageId: 70,
      sfwBackgroundImageId: null,
      pageTheme: { dark: { color: '#112233', opacity: 70 } },
      backgroundImage: scannedImage(NsfwLevel.PG),
      sfwBackgroundImage: null,
      ...over,
    };
    dbMock.dbRead.userProfile.findUnique.mockResolvedValue(row as never);
    dbMock.dbWrite.userProfile.findUnique.mockResolvedValue(row as never);
  };

  it("shows a member's background and colours to a visitor", async () => {
    subscriptions = [subscription('gold')];
    stored();
    const result = await getProfileCustomization({ userId: OWNER, viewerId: VISITOR });
    expect(result).toMatchObject({
      background: { id: 70 },
      pageTheme: { dark: { color: '#112233', opacity: 70 } },
    });
    expect(result.stored).toBeNull();
  });

  it('returns the light-mode pair beside the dark one', async () => {
    subscriptions = [subscription('gold')];
    stored({
      pageTheme: {
        dark: { color: '#112233', opacity: 70 },
        light: { color: '#f3ead7', opacity: 90 },
      },
    });
    const result = await getProfileCustomization({ userId: OWNER, viewerId: VISITOR });
    expect(result.pageTheme).toEqual({
      dark: { color: '#112233', opacity: 70 },
      light: { color: '#f3ead7', opacity: 90 },
    });
  });

  it('returns a sidebar colour set on its own, to visitors and to the owner to edit', async () => {
    subscriptions = [subscription('gold')];
    stored({
      backgroundImageId: null,
      backgroundImage: null,
      pageTheme: { sidebar: { color: '#1b2a4a' } },
    });
    const visitor = await getProfileCustomization({ userId: OWNER, viewerId: VISITOR });
    expect(visitor.pageTheme).toEqual({ sidebar: { color: '#1b2a4a' } });
    const owner = await getProfileCustomization({ userId: OWNER, viewerId: OWNER });
    expect(owner.stored?.pageTheme).toEqual({ sidebar: { color: '#1b2a4a' } });
  });

  it('ignores a stored theme that is not the allowed shape', async () => {
    subscriptions = [subscription('gold')];
    stored({
      backgroundImageId: null,
      backgroundImage: null,
      pageTheme: { dark: { color: 'red' } },
    });
    const result = await getProfileCustomization({ userId: OWNER, viewerId: VISITOR });
    expect(result.pageTheme).toBeNull();
  });

  it('hides them while the owner is not a member, but keeps them for the owner to edit', async () => {
    stored();
    const visitor = await getProfileCustomization({ userId: OWNER, viewerId: VISITOR });
    expect(visitor).toMatchObject({ background: null, pageTheme: null });
    const owner = await getProfileCustomization({ userId: OWNER, viewerId: OWNER });
    expect(owner.background).toBeNull();
    expect(owner.stored).toMatchObject({ pageTheme: { dark: { color: '#112233', opacity: 70 } } });
  });

  it('hides them when the membership lookup fails', async () => {
    stored();
    dbMock.dbWrite.customerSubscription.findMany.mockRejectedValue(new Error('down'));
    const result = await getProfileCustomization({ userId: OWNER, viewerId: VISITOR });
    expect(result.pageTheme).toBeNull();
  });

  it('never sends a mature background on civitai.com, even to its owner', async () => {
    subscriptions = [subscription('gold')];
    stored({ backgroundImage: scannedImage(NsfwLevel.R) });
    for (const viewerId of [VISITOR, OWNER]) {
      const result = await getProfileCustomization({ userId: OWNER, viewerId, domain: 'green' });
      expect(result.background).toBeNull();
    }
    const red = await getProfileCustomization({
      userId: OWNER,
      viewerId: VISITOR,
      domain: 'red',
      browsingLevel: NsfwLevel.PG | NsfwLevel.R,
    });
    expect(red.background).toMatchObject({ id: 70 });
  });

  it("does not send a background outside the visitor's browsing level", async () => {
    subscriptions = [subscription('gold')];
    stored({ backgroundImage: scannedImage(NsfwLevel.R) });
    const sfwVisitor = await getProfileCustomization({
      userId: OWNER,
      viewerId: VISITOR,
      domain: 'red',
      browsingLevel: NsfwLevel.PG,
    });
    expect(sfwVisitor.background).toBeNull();
    // Logged out, with no level sent, it is the public level.
    expect((await getProfileCustomization({ userId: OWNER, domain: 'red' })).background).toBeNull();
    const owner = await getProfileCustomization({
      userId: OWNER,
      viewerId: OWNER,
      domain: 'red',
      browsingLevel: NsfwLevel.PG,
    });
    expect(owner.background).toMatchObject({ id: 70 });
  });

  it('uses the civitai.com override there', async () => {
    subscriptions = [subscription('gold')];
    stored({
      sfwBackgroundImageId: 71,
      sfwBackgroundImage: scannedImage(NsfwLevel.PG, { id: 71 }),
    });
    const result = await getProfileCustomization({ userId: OWNER, domain: 'green' });
    expect(result.background).toMatchObject({ id: 71 });
  });

  it('does not serve its owner a background under a safety block, on the page or in the editor', async () => {
    subscriptions = [subscription('gold')];
    stored({
      backgroundImage: scannedImage(NsfwLevel.PG, { ingestion: 'Blocked', blockedFor: 'tos' }),
    });
    const owner = await getProfileCustomization({ userId: OWNER, viewerId: OWNER });
    expect(owner.background).toBeNull();
    expect(owner.stored?.backgroundImage).toBeNull();
    const moderator = await getProfileCustomization({
      userId: OWNER,
      viewerId: OWNER,
      isModerator: true,
    });
    expect(moderator.background).toMatchObject({ id: 70 });
  });

  it('withholds an unscanned background from visitors but not from its owner', async () => {
    subscriptions = [subscription('gold')];
    stored({ backgroundImage: scannedImage(NsfwLevel.PG, { ingestion: 'Pending' }) });
    expect(
      (await getProfileCustomization({ userId: OWNER, viewerId: VISITOR })).background
    ).toBeNull();
    expect(
      (await getProfileCustomization({ userId: OWNER, viewerId: OWNER })).background
    ).toMatchObject({ id: 70 });
  });
});

describe("the customizer's stored values", () => {
  it("withhold a restricted background from a moderator editing someone else's profile", async () => {
    const restricted = scannedImage(NsfwLevel.R, { modelRestricted: true });
    const row = {
      backgroundImageId: 70,
      sfwBackgroundImageId: null,
      pageTheme: null,
      backgroundImage: restricted,
      sfwBackgroundImage: null,
    };
    dbMock.dbRead.userProfile.findUnique.mockResolvedValue(row as never);
    dbMock.dbWrite.userProfile.findUnique.mockResolvedValue(row as never);
    const moderator = await getProfileCustomization({
      userId: OWNER,
      viewerId: VISITOR,
      isModerator: true,
    });
    expect(moderator.stored?.backgroundImage).toBeNull();
    const owner = await getProfileCustomization({ userId: OWNER, viewerId: OWNER });
    expect(owner.stored?.backgroundImage).toMatchObject({ id: 70 });
  });
});

describe('setProfileBackground', () => {
  it("refuses another user's image, also for a moderator, and writes nothing", async () => {
    subscriptions = [subscription('gold')];
    dbMock.dbRead.user.findUnique.mockResolvedValue({ isModerator: true } as never);
    dbMock.dbRead.image.findUnique.mockResolvedValue({ userId: VISITOR } as never);
    await expect(setProfileBackground({ userId: OWNER, imageId: 70 })).rejects.toThrow(
      /not found/i
    );
    expect(dbMock.dbWrite.userProfile.upsert).not.toHaveBeenCalled();
  });

  it("sets the owner's own image, as the civitai.com override on civitai.com", async () => {
    subscriptions = [subscription('gold')];
    dbMock.dbRead.image.findUnique.mockResolvedValue({ userId: OWNER } as never);
    await setProfileBackground({ userId: OWNER, imageId: 70, domain: 'green' });
    expect(dbMock.dbWrite.userProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { sfwBackgroundImageId: 70 } })
    );
  });

  it('refuses a non-member', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ userId: OWNER } as never);
    await expect(setProfileBackground({ userId: OWNER, imageId: 70 })).rejects.toThrow(
      /for members/
    );
  });
});
