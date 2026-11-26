import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { viewerCanSeeSourceMedia } from '~/server/utils/image-media-visibility';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * A blocked source counts as seen only by a moderator, and by its own owner where the block is
 * exempt (`ownerMediaAllowed`); the image's owner is held to the same.
 */

const IMAGE_OWNER = 7;
const OTHER = 8;
const image = { id: 1, userId: IMAGE_OWNER };
const meta = { extra: { sourceImageIds: [2] } };

const ctxFor = (user: { id: number; isModerator?: boolean }) =>
  ({
    user,
    tokenScope: TokenScope.Full,
    features: { canViewNsfw: true },
    req: { headers: {} },
  } as never);

const source = (userId: number, blocked: boolean) => ({
  nsfwLevel: NsfwLevel.PG,
  userId,
  ingestion: blocked ? 'Blocked' : 'Scanned',
  blockedFor: blocked ? BlockedReason.Moderated : null,
});

const sees = (viewer: { id: number; isModerator?: boolean }, row: object) => {
  dbMock.dbRead.$queryRaw.mockResolvedValue([row] as never);
  return viewerCanSeeSourceMedia(ctxFor(viewer), image, meta);
};

beforeEach(() => dbMock.dbRead.$queryRaw.mockReset());

describe('viewerCanSeeSourceMedia', () => {
  it("refuses the image's owner a source of theirs that is blocked, and keeps a clean one", async () => {
    expect(await sees({ id: IMAGE_OWNER }, source(IMAGE_OWNER, true))).toBe(false);
    expect(await sees({ id: IMAGE_OWNER }, source(IMAGE_OWNER, false))).toBe(true);
  });

  it("refuses the image's owner another user's blocked source, and keeps a clean one", async () => {
    expect(await sees({ id: IMAGE_OWNER }, source(OTHER, true))).toBe(false);
    expect(await sees({ id: IMAGE_OWNER }, source(OTHER, false))).toBe(true);
  });

  it("refuses a viewer their own blocked source on someone else's image, and keeps a clean one", async () => {
    expect(await sees({ id: OTHER }, source(OTHER, true))).toBe(false);
    expect(await sees({ id: OTHER }, source(OTHER, false))).toBe(true);
  });

  it('leaves the owner a source of theirs held only for an exempt block', async () => {
    const held = { ...source(IMAGE_OWNER, true), blockedFor: BlockedReason.AiNotVerified };
    expect(await sees({ id: IMAGE_OWNER }, held)).toBe(true);
    expect(await sees({ id: OTHER }, { ...held, userId: OTHER })).toBe(true);
  });

  it('leaves a moderator a blocked source', async () => {
    expect(await sees({ id: 99, isModerator: true }, source(OTHER, true))).toBe(true);
  });
});
