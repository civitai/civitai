import { describe, it, expect } from 'vitest';
import { Model3DStatus } from '~/shared/utils/prisma/enums';
import { canViewModel3d } from '~/server/services/model3d.visibility';

// ---------------------------------------------------------------------------
// canViewModel3d is the AUTHZ predicate that gates the `model3dId` field now
// surfaced on the `image.get` payload (the durable replacement for the ambient
// `model3d.getByPostId` chip call). It MUST match `getModel3DById`'s rules so
// that threading `model3dId` onto the image payload never reveals a Model3D
// the viewer couldn't otherwise see (a hidden draft / deleted / other user's).
// ---------------------------------------------------------------------------

const OWNER = 42;
const OTHER = 7;

describe('canViewModel3d — authZ for the image-payload model3dId gate', () => {
  it('moderators see everything (any status, even deleted, any owner)', () => {
    expect(
      canViewModel3d({
        status: Model3DStatus.Draft,
        deletedAt: new Date(),
        tosViolation: false,
        ownerId: OWNER,
        userId: OTHER,
        isModerator: true,
      })
    ).toBe(true);
  });

  it('the owner sees their own at any status', () => {
    expect(
      canViewModel3d({
        status: Model3DStatus.Draft,
        deletedAt: null,
        tosViolation: false,
        ownerId: OWNER,
        userId: OWNER,
      })
    ).toBe(true);
    expect(
      canViewModel3d({
        status: Model3DStatus.Published,
        deletedAt: null,
        tosViolation: false,
        ownerId: OWNER,
        userId: OWNER,
      })
    ).toBe(true);
  });

  it('the public sees a Published, not-deleted model', () => {
    expect(
      canViewModel3d({
        status: Model3DStatus.Published,
        deletedAt: null,
        tosViolation: false,
        ownerId: OWNER,
      })
    ).toBe(true);
    expect(
      canViewModel3d({
        status: Model3DStatus.Published,
        deletedAt: null,
        tosViolation: false,
        ownerId: OWNER,
        userId: OTHER,
      })
    ).toBe(true);
  });

  it('hides a non-Published model from a non-owner non-mod', () => {
    expect(
      canViewModel3d({
        status: Model3DStatus.Draft,
        deletedAt: null,
        tosViolation: false,
        ownerId: OWNER,
        userId: OTHER,
      })
    ).toBe(false);
    // anonymous (no userId) is treated as public
    expect(
      canViewModel3d({
        status: Model3DStatus.Draft,
        deletedAt: null,
        tosViolation: false,
        ownerId: OWNER,
      })
    ).toBe(false);
  });

  it('hides a deleted model from a non-owner non-mod even when Published', () => {
    expect(
      canViewModel3d({
        status: Model3DStatus.Published,
        deletedAt: new Date(),
        tosViolation: false,
        ownerId: OWNER,
        userId: OTHER,
      })
    ).toBe(false);
  });

  it('owner does NOT match when userId is undefined (anonymous never an owner)', () => {
    expect(
      canViewModel3d({
        status: Model3DStatus.Draft,
        deletedAt: null,
        tosViolation: false,
        ownerId: OWNER,
        userId: undefined,
      })
    ).toBe(false);
  });

  it('a model a moderator removed is hidden from everyone but its owner and moderators', () => {
    const removed = {
      status: Model3DStatus.Published,
      deletedAt: null,
      tosViolation: true,
      ownerId: OWNER,
    };
    expect(canViewModel3d({ ...removed })).toBe(false);
    expect(canViewModel3d({ ...removed, userId: OTHER })).toBe(false);
    expect(canViewModel3d({ ...removed, userId: OWNER })).toBe(true);
    expect(canViewModel3d({ ...removed, userId: OTHER, isModerator: true })).toBe(true);
    // Control: the same model in good standing is public.
    expect(canViewModel3d({ ...removed, tosViolation: false, userId: OTHER })).toBe(true);
  });
});
