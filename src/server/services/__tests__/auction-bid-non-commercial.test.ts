import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import dayjs from '~/shared/utils/dayjs';
import { TransactionType } from '~/shared/constants/buzz.constants';

// Promoting a version on the FLUX non-commercial license (Flux.2 Klein 9B) takes Buzz for a
// model that can't be sold, so a new bid is refused and a standing recurring bid isn't charged.
const { getUserBuzzAccount, createMultiAccountBuzzTransaction } = vi.hoisted(() => ({
  getUserBuzzAccount: vi.fn(),
  createMultiAccountBuzzTransaction: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccount,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
  refundTransaction: vi.fn(),
  getTransactionByExternalId: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: vi.fn(), topicSend: vi.fn() } }));
vi.mock('~/components/Auction/auction.utils', () => ({
  getModelTypesForAuction: vi.fn(() => [{ type: 'LORA', baseModels: [] }]),
  miscAuctionName: 'Misc',
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: unknown) => ({ name, cron, run: fn }),
  getJobDate: vi.fn(),
}));
vi.mock('~/server/services/model.service', () => ({
  bustFeaturedModelsCache: vi.fn(),
  getTopWeeklyEarners: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { updateSync: vi.fn() } }));
vi.mock('~/server/services/home-block-cache.service', () => ({
  bustFeaturedModelsHomeBlockCache: vi.fn(),
}));

import { createBid } from '~/server/services/auction.service';
import { _createRecurringBids } from '~/server/jobs/handle-auctions';

const VERSION_ID = 5;
const version = (baseModel: string) => ({
  baseModel,
  availability: 'Public',
  nsfwLevel: 1,
  status: 'Published',
  model: {
    type: 'LORA',
    meta: null,
    poi: false,
    minor: false,
    status: 'Published',
    nsfwLevel: 1,
    nsfw: false,
    availability: 'Public',
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  getUserBuzzAccount.mockResolvedValue([{ balance: 0 }]);
  createMultiAccountBuzzTransaction.mockResolvedValue({ transactionIds: ['tx'] });
});

describe('createBid on a model auction', () => {
  const bid = () =>
    createBid({
      userId: 1,
      auctionId: 20,
      entityId: VERSION_ID,
      amount: 100,
      accountTypes: ['yellow'],
    } as Parameters<typeof createBid>[0]);

  beforeEach(() => {
    dbMock.dbWrite.auction.findFirst.mockResolvedValue({
      id: 20,
      startAt: dayjs().subtract(1, 'hour').toDate(),
      endAt: dayjs().add(1, 'hour').toDate(),
      auctionBase: { id: 10, type: 'Model', ecosystem: 'Misc' },
      bids: [],
    } as never);
  });

  it.each(['Flux.2 Klein 9B', 'Flux.2 Klein 9B-base'])(
    'refuses a bid on a %s version before reading the bidder balance',
    async (baseModel) => {
      dbMock.dbWrite.modelVersion.findFirst.mockResolvedValue(version(baseModel) as never);
      await expect(bid()).rejects.toThrow(
        `This model isn't commercially available at the moment. Its base model, ${baseModel}, is licensed for non-commercial use only.`
      );
      expect(getUserBuzzAccount).not.toHaveBeenCalled();
      expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    }
  );

  it.each(['Flux.2 Klein 4B', 'Flux.3 Klein'])(
    'a %s version passes the gate and reaches the balance check',
    async (baseModel) => {
      dbMock.dbWrite.modelVersion.findFirst.mockResolvedValue(version(baseModel) as never);
      await expect(bid()).rejects.toThrow(/don't have/);
      expect(getUserBuzzAccount).toHaveBeenCalledTimes(1);
    }
  );
});

describe('the daily recurring-bid charge', () => {
  beforeEach(() => {
    dbMock.dbWrite.bidRecurring.findMany.mockResolvedValue([
      {
        id: 100,
        userId: 1,
        entityId: VERSION_ID,
        amount: 100,
        accountType: 'yellow',
        auctionBase: { id: 10, type: 'Model' },
      },
    ] as never);
    dbMock.dbWrite.auction.findMany.mockResolvedValue([
      { id: 20, auctionBase: { id: 10, name: 'Misc' } },
    ] as never);
    dbMock.dbWrite.bid.findFirst.mockResolvedValue(null as never);
  });

  it.each(['Flux.2 Klein 9B', 'Flux.2 Klein 9B-base'])(
    'does not charge a recurring bid on a %s version',
    async (baseModel) => {
      dbMock.dbWrite.modelVersion.findFirst.mockResolvedValue(version(baseModel) as never);
      await _createRecurringBids(dayjs());
      expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    }
  );

  it.each(['Flux.2 Klein 4B', 'Flux.3 Klein'])(
    'still charges a recurring bid on a %s version',
    async (baseModel) => {
      dbMock.dbWrite.modelVersion.findFirst.mockResolvedValue(version(baseModel) as never);
      await _createRecurringBids(dayjs());
      expect(createMultiAccountBuzzTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ fromAccountId: 1, amount: 100, type: TransactionType.Bid })
      );
    }
  );
});
