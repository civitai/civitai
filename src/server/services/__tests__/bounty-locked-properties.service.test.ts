import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for bounty lock enforcement — locks come from the stored row, never from the
// client payload. bounty.service.ts has a large import graph, so its transitive
// service/db/queue dependencies are stubbed out below. Mirrors the mock scaffold used in
// model-locked-properties.service.test.ts.

const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const mk = () => ({
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  });
  const tx = {
    bounty: mk(),
    bountyBenefactor: mk(),
    bountyEntry: mk(),
    image: mk(),
    tagsOnBounty: mk(),
  };
  return {
    mockDbRead: { bounty: mk(), $queryRaw: vi.fn() },
    mockDbWrite: {
      ...tx,
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});

const { mockEvaluateContent, mockThrowOnBlockedLinkDomain, mockBuzzTransaction } = vi.hoisted(
  () => ({
    mockEvaluateContent: vi.fn(),
    mockThrowOnBlockedLinkDomain: vi.fn(),
    mockBuzzTransaction: vi.fn(),
  })
);

vi.mock('~/libs/profanity-simple', () => ({
  createProfanityFilter: () => ({ evaluateContent: mockEvaluateContent }),
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: mockThrowOnBlockedLinkDomain,
}));
vi.mock('~/server/services/image.service', () => ({
  createEntityImages: vi.fn(async () => []),
  updateEntityImages: vi.fn(async () => []),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createMultiAccountBuzzTransaction: mockBuzzTransaction,
  getUserBuzzAccount: vi.fn(async () => [{ balance: 1_000_000 }]),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/redis/caches', () => ({
  userBountyCountCache: { refresh: vi.fn() },
}));

import { updateBountyById, upsertBounty } from '~/server/services/bounty.service';
import { constants } from '~/server/common/constants';

const BOUNTY_ID = 55;
const OWNER_ID = 7;
const MODERATOR_ID = 9;

// updateBountyById reads `existing` inside the transaction; upsertBounty reads the stored
// locks up front via dbRead. Both are pointed at the same row here.
function mockStored({
  lockedProperties = [] as string[],
  complete = false,
}: { lockedProperties?: string[]; complete?: boolean } = {}) {
  mockDbRead.bounty.findUnique.mockResolvedValue({ lockedProperties });
  mockDbWrite.bounty.findUniqueOrThrow.mockResolvedValue({
    id: BOUNTY_ID,
    entryLimit: null,
    complete,
    lockedProperties,
    _count: { entries: 0 },
  });
}

function updateData() {
  return mockDbWrite.bounty.update.mock.calls.at(-1)?.[0]?.data ?? {};
}

function createData() {
  return mockDbWrite.bounty.create.mock.calls.at(-1)?.[0]?.data ?? {};
}

const baseUpdate = {
  id: BOUNTY_ID,
  userId: OWNER_ID,
  name: 'A bounty',
  description: 'Some description',
  type: 'ModelCreation',
  details: {},
  startsAt: new Date('2026-01-01'),
  expiresAt: new Date('2026-02-01'),
  tags: undefined,
  files: undefined,
  images: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockStored();
  mockEvaluateContent.mockReturnValue({ shouldMarkNSFW: false });
  mockDbWrite.bounty.update.mockResolvedValue({ id: BOUNTY_ID, userId: OWNER_ID });
  mockDbWrite.bounty.create.mockResolvedValue({ id: BOUNTY_ID, userId: OWNER_ID });
});

describe('updateBountyById — lock enforcement', () => {
  it('strips a DB-locked field even when the client claims no locks', async () => {
    mockStored({ lockedProperties: ['nsfw'] });

    await updateBountyById({ ...baseUpdate, nsfw: false, lockedProperties: [] } as never);

    const data = updateData();
    expect(data).not.toHaveProperty('nsfw');
  });

  it('never lets a non-moderator write lockedProperties — the stored locks must survive', async () => {
    // Passing the client array through to the write would replace the stored locks with [],
    // permanently unlocking the bounty.
    mockStored({ lockedProperties: ['nsfw', 'poi'] });

    await updateBountyById({
      ...baseUpdate,
      nsfw: true,
      poi: true,
      lockedProperties: [],
    } as never);

    const data = updateData();
    expect(data).not.toHaveProperty('lockedProperties');
    expect(data).not.toHaveProperty('nsfw');
    expect(data).not.toHaveProperty('poi');
  });

  it('ignores locks the client claims — only the stored row decides what is locked', async () => {
    await updateBountyById({ ...baseUpdate, poi: true, lockedProperties: ['poi'] } as never);

    const data = updateData();
    expect(data.poi).toBe(true);
    expect(data).not.toHaveProperty('lockedProperties');
  });

  it('lets a moderator write lockedProperties and the locked values themselves', async () => {
    mockStored({ lockedProperties: ['nsfw'] });

    await updateBountyById({
      ...baseUpdate,
      userId: MODERATOR_ID,
      isModerator: true,
      nsfw: false,
      lockedProperties: ['nsfw', 'poi'],
    } as never);

    const data = updateData();
    expect(data.nsfw).toBe(false);
    expect(data.lockedProperties).toEqual(['nsfw', 'poi']);
  });

  it('reads the stored locks from the row it is about to update', async () => {
    await updateBountyById({ ...baseUpdate } as never);

    expect(mockDbWrite.bounty.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ lockedProperties: true }) })
    );
  });
});

describe('upsertBounty — profanity filter vs stored locks', () => {
  // upsertBounty re-parses through updateBountyInputSchema, which requires at least one
  // image and an expiry in the future.
  const upsert = (input: Record<string, unknown>) =>
    upsertBounty({
      isModerator: false,
      ...baseUpdate,
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      images: [{ url: '00000000-0000-4000-8000-000000000000' }],
      ...input,
    } as never);

  beforeEach(() => {
    mockEvaluateContent.mockReturnValue({
      shouldMarkNSFW: true,
      matchedWords: ['bad'],
      reason: 'threshold',
      metrics: {},
    });
  });

  it('marks the bounty nsfw and locks nsfw when nothing is locked yet', async () => {
    await upsert({});

    const data = updateData();
    expect(data.nsfw).toBe(true);
    expect(data.lockedProperties).toEqual(['nsfw']);
  });

  it('keeps the stored locks when adding its nsfw lock', async () => {
    mockStored({ lockedProperties: ['poi'] });

    await upsert({});

    expect(updateData().lockedProperties).toEqual(['poi', 'nsfw']);
  });

  it('records the detection but does not override a DB-locked nsfw', async () => {
    mockStored({ lockedProperties: ['nsfw'] });

    await upsert({ nsfw: false });

    const data = updateData();
    expect(data).not.toHaveProperty('nsfw');
    expect(data).not.toHaveProperty('lockedProperties');
    expect(data.details).toEqual(expect.objectContaining({ profanityMatches: ['bad'] }));
  });

  it('does not run for a moderator', async () => {
    await upsert({ isModerator: true, nsfw: false });

    const data = updateData();
    expect(data.nsfw).toBe(false);
    expect(data).not.toHaveProperty('lockedProperties');
  });
});

describe('upsertBounty — create path', () => {
  // No `id`, so upsertBounty takes the create branch. createBountyInputSchema is stricter than
  // the update one, hence the full payload.
  const create = (input: Record<string, unknown> = {}) =>
    upsertBounty({
      isModerator: false,
      userId: OWNER_ID,
      name: 'A bounty',
      description: 'Some description',
      type: 'ModelCreation',
      mode: 'Individual',
      entryMode: 'BenefactorsOnly',
      currency: 'BUZZ',
      unitAmount: constants.bounties.minCreateAmount,
      minBenefactorUnitAmount: 1,
      details: {},
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      images: [{ url: '00000000-0000-4000-8000-000000000000' }],
      ...input,
    } as never);

  const chargedAccountTypes = () =>
    mockBuzzTransaction.mock.calls.at(-1)?.[0]?.fromAccountTypes ?? [];

  it('charges green buzz when the caller asked for green', async () => {
    await create({ buzzType: 'green' });

    expect(chargedAccountTypes()).toEqual(['green']);
  });

  it('locks nsfw on a green-buzz bounty so it can never be flipped later', async () => {
    await create({ buzzType: 'green' });

    expect(createData().lockedProperties).toEqual(['nsfw']);
  });

  it('refuses to create an nsfw bounty paid in green buzz', async () => {
    await expect(create({ buzzType: 'green', nsfw: true })).rejects.toThrow(/Green Buzz/);
    expect(mockBuzzTransaction).not.toHaveBeenCalled();
  });

  it('charges yellow buzz and leaves nsfw unlocked otherwise', async () => {
    await create({ buzzType: 'yellow' });

    expect(chargedAccountTypes()).toEqual(['yellow']);
    expect(createData().lockedProperties).toBeUndefined();
  });

  it('carries the profanity filter nsfw lock into the new row', async () => {
    mockEvaluateContent.mockReturnValue({
      shouldMarkNSFW: true,
      matchedWords: ['bad'],
      reason: 'threshold',
      metrics: {},
    });

    await create({ buzzType: 'yellow' });

    const data = createData();
    expect(data.nsfw).toBe(true);
    expect(data.lockedProperties).toEqual(['nsfw']);
  });
});
