import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getShopServiceOfferings,
  removeServiceOffering,
  setServiceOfferingStatus,
  upsertServiceOffering,
} from '~/server/services/creator-service.service';
import {
  SERVICE_MAX_ACTIVE_OFFERINGS,
  SERVICES_MIN_CREATOR_SCORE,
} from '~/shared/constants/creator-service.constants';
import { ServiceOfferingStatus } from '~/shared/utils/prisma/enums';

const SELLER = 7;
const fields = {
  title: 'Custom badge',
  description: 'One animated badge.',
  price: 4000,
  deliveryDays: 5,
  revisionsIncluded: 2,
  maxOpenDeals: 3,
  previewKind: 'Image' as const,
};

const seller = ({ score = SERVICES_MIN_CREATOR_SCORE, muted = false } = {}) => {
  dbMock.dbRead.user.findUnique.mockResolvedValue({
    meta: { scores: { total: score } },
    bannedAt: null,
    muted,
    deletedAt: null,
  } as never);
  dbMock.dbRead.userStrike.aggregate.mockResolvedValue({ _sum: { points: 0 } } as never);
};

const rejects = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: Error) => e.message
  );

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.serviceOffering.count.mockResolvedValue(0 as never);
  dbMock.dbWrite.serviceOffering.create.mockResolvedValue({ id: 1 } as never);
  dbMock.dbWrite.serviceOffering.update.mockResolvedValue({ id: 1 } as never);
  dbMock.dbWrite.serviceOffering.updateMany.mockResolvedValue({ count: 1 } as never);
});

describe('sell gate', () => {
  it('refuses to create below Beacon and writes nothing', async () => {
    seller({ score: SERVICES_MIN_CREATOR_SCORE - 1 });
    expect(
      await rejects(
        upsertServiceOffering({ sellerId: SELLER, input: { ...fields, publish: false } })
      )
    ).toMatch(/unlocks at a Creator Score/);
    expect(dbMock.dbWrite.serviceOffering.create).not.toHaveBeenCalled();
  });

  it('refuses a muted seller at any score', async () => {
    seller({ score: SERVICES_MIN_CREATOR_SCORE * 2, muted: true });
    expect(
      await rejects(
        upsertServiceOffering({ sellerId: SELLER, input: { ...fields, publish: true } })
      )
    ).toMatch(/Muted/);
    expect(dbMock.dbWrite.serviceOffering.create).not.toHaveBeenCalled();
  });

  it('refuses to activate below Beacon, but still lets the seller pause', async () => {
    seller({ score: SERVICES_MIN_CREATOR_SCORE - 1 });
    expect(
      await rejects(
        setServiceOfferingStatus({ sellerId: SELLER, input: { id: 3, status: 'Active' } })
      )
    ).toMatch(/unlocks at a Creator Score/);
    expect(dbMock.dbWrite.serviceOffering.updateMany).not.toHaveBeenCalled();

    await setServiceOfferingStatus({ sellerId: SELLER, input: { id: 3, status: 'Paused' } });
    expect(dbMock.dbWrite.serviceOffering.updateMany).toHaveBeenCalledWith({
      where: { id: 3, sellerId: SELLER, status: { in: [ServiceOfferingStatus.Active] } },
      data: { status: ServiceOfferingStatus.Paused },
    });
  });
});

describe('writes', () => {
  it('creates a draft unless published, owned by the caller', async () => {
    seller();
    await upsertServiceOffering({ sellerId: SELLER, input: { ...fields, publish: false } });
    await upsertServiceOffering({ sellerId: SELLER, input: { ...fields, publish: true } });
    const statuses = dbMock.dbWrite.serviceOffering.create.mock.calls.map(
      ([args]) => (args as { data: { status: string; sellerId: number } }).data
    );
    expect(statuses).toEqual([
      expect.objectContaining({ status: ServiceOfferingStatus.Draft, sellerId: SELLER }),
      expect.objectContaining({ status: ServiceOfferingStatus.Active, sellerId: SELLER }),
    ]);
  });

  it('refuses to publish past the active cap', async () => {
    seller();
    dbMock.dbWrite.serviceOffering.count.mockResolvedValue(SERVICE_MAX_ACTIVE_OFFERINGS as never);
    expect(
      await rejects(
        upsertServiceOffering({ sellerId: SELLER, input: { ...fields, publish: true } })
      )
    ).toMatch(/at most/);
    expect(dbMock.dbWrite.serviceOffering.create).not.toHaveBeenCalled();
  });

  it("only edits the caller's own, non-removed offering", async () => {
    seller();
    dbMock.dbWrite.serviceOffering.findFirst.mockResolvedValue(null as never);
    expect(
      await rejects(
        upsertServiceOffering({ sellerId: SELLER, input: { ...fields, id: 9, publish: false } })
      )
    ).toMatch(/not found/i);
    expect(dbMock.dbWrite.serviceOffering.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 9, sellerId: SELLER, status: { not: ServiceOfferingStatus.Removed } },
      })
    );
    expect(dbMock.dbWrite.serviceOffering.update).not.toHaveBeenCalled();
  });

  it('removes by status, scoped to the caller', async () => {
    await removeServiceOffering({ sellerId: SELLER, id: 4 });
    expect(dbMock.dbWrite.serviceOffering.updateMany).toHaveBeenCalledWith({
      where: { id: 4, sellerId: SELLER, status: { not: ServiceOfferingStatus.Removed } },
      data: { status: ServiceOfferingStatus.Removed },
    });
  });
});

it('shows only Active offerings of a seller in good standing on the storefront', async () => {
  dbMock.dbRead.serviceOffering.findMany.mockResolvedValue([] as never);
  await getShopServiceOfferings({ userId: SELLER });
  expect(dbMock.dbRead.serviceOffering.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        sellerId: SELLER,
        status: ServiceOfferingStatus.Active,
        seller: { bannedAt: null, deletedAt: null },
      },
    })
  );
});
