import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as UserService from '~/server/services/user.service';
import { updateCreatorShopSettings } from '~/server/services/creator-shop.service';
import { servicesCountForPublish } from '~/server/services/creator-service.service';
import { ServiceOfferingStatus } from '~/shared/utils/prisma/enums';

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  patchUserSettings: vi.fn().mockResolvedValue({}),
}));

const EMPTY_SHOP = 'Add at least one item to your shop before publishing.';
const USER = 11;

const publish = (servicesEnabled: boolean) =>
  updateCreatorShopSettings({ userId: USER, enabled: true, servicesEnabled }).then(
    () => 'published',
    (e: Error) => e.message
  );

// Only Active offerings exist in this fake; the real filter is pinned by the `where` assertion.
const activeOfferings = (n: number) =>
  dbMock.dbWrite.serviceOffering.count.mockImplementation((async (args: {
    where: { status?: string };
  }) => (args.where.status === ServiceOfferingStatus.Active ? n : 99)) as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.cosmeticShopItem.count.mockResolvedValue(0 as never);
});

describe('publishing a shop with no cosmetics', () => {
  it('refuses while creatorServices is off, even with an Active offering', async () => {
    activeOfferings(1);
    expect(await publish(false)).toBe(EMPTY_SHOP);
    expect(dbMock.dbWrite.serviceOffering.count).not.toHaveBeenCalled();
  });

  it('publishes with creatorServices on and one Active offering', async () => {
    activeOfferings(1);
    expect(await publish(true)).toBe('published');
    expect(dbMock.dbWrite.serviceOffering.count).toHaveBeenCalledWith({
      where: { sellerId: USER, status: ServiceOfferingStatus.Active, seller: { muted: false } },
    });
  });

  it('refuses with creatorServices on when no offering is Active (Draft or Paused only)', async () => {
    activeOfferings(0);
    expect(await publish(true)).toBe(EMPTY_SHOP);
  });
});

// Decision (Creator Services P1): the router can only see the CALLER's flags, so the services
// count applies to an owner publishing their own shop. A moderator publishing for a seller gets
// the cosmetics-only rule rather than borrowing the moderator's flags. Keep it fail-closed.
describe('servicesCountForPublish', () => {
  const MOD = 1;
  it('counts services for the owner with the flag on', () => {
    expect(
      servicesCountForPublish({ shopOwnerId: USER, callerId: USER, callerHasServicesFlag: true })
    ).toBe(true);
  });

  it('does not count them for a moderator acting for the owner, flag on or not', () => {
    expect(
      servicesCountForPublish({ shopOwnerId: USER, callerId: MOD, callerHasServicesFlag: true })
    ).toBe(false);
  });

  it('does not count them for the owner with the flag off', () => {
    expect(
      servicesCountForPublish({ shopOwnerId: USER, callerId: USER, callerHasServicesFlag: false })
    ).toBe(false);
  });
});
