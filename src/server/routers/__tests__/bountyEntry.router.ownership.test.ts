import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

const { mockUpsert, mockSubmit } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockSubmit: vi.fn(),
}));

vi.mock('~/server/controllers/bountyEntry.controller', () => ({
  awardBountyEntryHandler: vi.fn(),
  deleteBountyEntryHandler: vi.fn(),
  getBountyEntryFilteredFilesHandler: vi.fn(),
  getBountyEntryHandler: vi.fn(),
  upsertBountyEntryHandler: (...args: unknown[]) => mockUpsert(...args),
  submitBountyEntryHandler: (...args: unknown[]) => mockSubmit(...args),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ bounties: true }),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { bountyEntryRouter } from '~/server/routers/bountyEntry.router';
import { OnboardingComplete } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const ENTRY_ID = 20;
const AUTHOR_ID = 2;
const OTHER_ID = 3;

function callerFor(id: number, isModerator = false) {
  return bountyEntryRouter.createCaller({
    user: {
      id,
      isModerator,
      onboarding: OnboardingComplete,
      emailVerified: new Date(),
      muted: false,
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

const upsertInput = {
  id: ENTRY_ID,
  bountyId: 10,
  files: [{ url: 'https://example.com/f.zip', name: 'f.zip', sizeKB: 1, metadata: {} }],
  images: [{ url: '00000000-0000-4000-8000-000000000000', type: 'image' }],
};
const submitInput = {
  id: ENTRY_ID,
  bountyId: 10,
  files: [{ url: 'https://example.com/f.zip', name: 'f.zip', sizeKB: 1 }],
  imageUuids: ['00000000-0000-4000-8000-000000000000'],
};

describe('bountyEntry router: editing an existing entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: ENTRY_ID });
    mockSubmit.mockResolvedValue({ id: ENTRY_ID });
    dbMock.dbWrite.bountyEntry.findUnique.mockImplementation((async ({
      where,
    }: {
      where: { id: number };
    }) => (where.id === ENTRY_ID ? { userId: AUTHOR_ID } : null)) as never);
  });

  it("refuses an upsert of someone else's entry", async () => {
    await expect(callerFor(OTHER_ID).upsert(upsertInput as never)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'You are not authorized to perform this action',
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("refuses a submit of someone else's entry", async () => {
    await expect(callerFor(OTHER_ID).submit(submitInput as never)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'You are not authorized to perform this action',
    });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('lets the author upsert and submit their own entry', async () => {
    await callerFor(AUTHOR_ID).upsert(upsertInput as never);
    await callerFor(AUTHOR_ID).submit(submitInput as never);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it('lets a moderator edit any entry', async () => {
    await callerFor(OTHER_ID, true).upsert(upsertInput as never);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('does not look up ownership when creating a new entry', async () => {
    const { id: _id, ...create } = upsertInput;
    await callerFor(OTHER_ID).upsert(create as never);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.bountyEntry.findUnique).not.toHaveBeenCalled();
  });
});
