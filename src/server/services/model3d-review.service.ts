import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { Model3DStatus } from '~/shared/utils/prisma/enums';
import type {
  DeleteModel3DReviewInput,
  GetModel3DReviewsInput,
  UpsertModel3DReviewInput,
} from '~/server/schema/model3d.schema';

type SessionUser = {
  id: number;
  isModerator?: boolean | null;
  username?: string | null;
};

const reviewSelect = {
  id: true,
  model3dId: true,
  userId: true,
  recommended: true,
  details: true,
  nsfw: true,
  tosViolation: true,
  exclude: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  user: { select: userWithCosmeticsSelect },
  post: {
    select: {
      id: true,
      // Post images for hydration. Keep the projection minimal — the detail
      // page can re-fetch the post for the full hydration if needed.
      images: {
        select: {
          id: true,
          url: true,
          name: true,
          width: true,
          height: true,
          nsfwLevel: true,
          type: true,
          metadata: true,
        },
        orderBy: { index: 'asc' as const },
      },
    },
  },
} satisfies Prisma.Model3DReviewSelect;

export type Model3DReviewGetById = NonNullable<Awaited<ReturnType<typeof getModel3DReviewById>>>;
export const getModel3DReviewById = async ({ id }: { id: number }) => {
  try {
    return await dbRead.model3DReview.findUnique({
      where: { id },
      select: reviewSelect,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const upsertModel3DReview = async ({
  input,
  user,
}: {
  input: UpsertModel3DReviewInput;
  user: SessionUser;
}) => {
  const { model3dId, recommended, details, postId } = input;
  let { id } = input;

  // Resolve the (model3dId, userId) uniqueness up-front: if a row already
  // exists, treat the call as an update of that row. Avoids recursion + a
  // duplicate-key crash if the client forgets to send `id`.
  if (!id) {
    const dupe = await dbRead.model3DReview.findUnique({
      where: { model3dId_userId: { model3dId, userId: user.id } },
      select: { id: true },
    });
    if (dupe) id = dupe.id;
  }

  // Guard: must target a real, non-deleted Model3D. Published-or-owner gating
  // happens elsewhere — reviewers may be reviewing a mod's draft for QA.
  const model3d = await dbRead.model3D.findUnique({
    where: { id: model3dId },
    select: { id: true, userId: true, status: true, deletedAt: true },
  });
  if (!model3d || model3d.deletedAt) {
    throw throwNotFoundError(`No 3D model with id ${model3dId}`);
  }
  if (
    model3d.status !== Model3DStatus.Published &&
    !user.isModerator &&
    model3d.userId !== user.id
  ) {
    throw throwBadRequestError('Cannot review a 3D model that has not been published.');
  }

  // If a postId is provided, validate it actually exists + belongs to this user
  // (or a mod). Post.model3dReviewId is @unique, so we have to be careful to
  // not stomp on another review.
  if (postId) {
    const post = await dbRead.post.findUnique({
      where: { id: postId },
      select: { id: true, userId: true, model3dReviewId: true },
    });
    if (!post) throw throwNotFoundError(`No post with id ${postId}`);
    if (post.userId !== user.id && !user.isModerator) {
      throw throwAuthorizationError('You do not own that post.');
    }
    if (post.model3dReviewId && post.model3dReviewId !== id) {
      throw throwBadRequestError('That post is already linked to a different 3D review.');
    }
  }

  try {
    if (id) {
      const existing = await dbWrite.model3DReview.findUnique({
        where: { id },
        select: { id: true, userId: true, model3dId: true },
      });
      if (!existing) throw throwNotFoundError(`No review with id ${id}`);
      if (!user.isModerator && existing.userId !== user.id) throw throwAuthorizationError();
      if (existing.model3dId !== model3dId) {
        throw throwBadRequestError('Cannot move a review between 3D models.');
      }

      return await dbWrite.$transaction(async (tx) => {
        const updated = await tx.model3DReview.update({
          where: { id },
          data: { recommended, details },
          select: reviewSelect,
        });
        if (postId !== undefined) {
          // Detach any existing post first.
          await tx.post.updateMany({
            where: { model3dReviewId: id, NOT: { id: postId ?? -1 } },
            data: { model3dReviewId: null },
          });
          if (postId) {
            await tx.post.update({
              where: { id: postId },
              data: { model3dReviewId: id },
            });
          }
        }
        return updated;
      });
    }

    // Create — Model3DReview is unique on (model3dId, userId). The
    // dedup-then-update above ensures we only reach this branch when there's
    // truly no existing row.
    return await dbWrite.$transaction(async (tx) => {
      const created = await tx.model3DReview.create({
        data: {
          model3dId,
          userId: user.id,
          recommended,
          details,
        },
        select: reviewSelect,
      });
      if (postId) {
        await tx.post.update({
          where: { id: postId },
          data: { model3dReviewId: created.id },
        });
      }
      return created;
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getModel3DReviews = async ({
  input,
  user,
}: {
  input: GetModel3DReviewsInput;
  user?: SessionUser | null;
}) => {
  try {
    const { model3dId, username, hasDetails } = input;
    const { take, skip } = getPagination(input.limit, input.page);

    const where: Prisma.Model3DReviewWhereInput = {
      model3dId,
      ...(username ? { user: { username } } : {}),
      ...(hasDetails ? { details: { not: null } } : {}),
      // Hide reviews that were excluded by a mod, unless the requester is the
      // mod or the review's author.
      ...(user?.isModerator
        ? {}
        : { OR: [{ exclude: false }, ...(user ? [{ userId: user.id }] : [])] }),
    };

    const [items, count] = await Promise.all([
      dbRead.model3DReview.findMany({
        where,
        take,
        skip,
        orderBy: { createdAt: 'desc' },
        select: reviewSelect,
      }),
      dbRead.model3DReview.count({ where }),
    ]);

    return getPagingData({ items, count }, take, input.page);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const deleteModel3DReview = async ({
  input,
  user,
}: {
  input: DeleteModel3DReviewInput;
  user: SessionUser;
}) => {
  const existing = await dbWrite.model3DReview.findUnique({
    where: { id: input.id },
    select: { id: true, userId: true },
  });
  if (!existing) throw throwNotFoundError(`No review with id ${input.id}`);
  if (!user.isModerator && existing.userId !== user.id) throw throwAuthorizationError();

  try {
    return await dbWrite.model3DReview.delete({
      where: { id: input.id },
      select: { id: true },
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
