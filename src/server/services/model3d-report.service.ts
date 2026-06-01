/**
 * Direct-path report creation for Model3D / Model3DReview.
 *
 * NOTE: This bypasses the centralized `report.service.createReport` flow and
 * therefore does NOT run the NSFW / TOS / CSAM side effects that
 * `report.service` applies (Image hide, Post.nsfw=true, etc.). New UI callers
 * should use `trpc.report.create` via `ReportModal` (workstream Q) so those
 * side effects fire. Kept for programmatic / SDK callers that need to skip
 * those effects intentionally.
 */
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';
import type {
  CreateModel3DReportInput,
  CreateModel3DReviewReportInput,
} from '~/server/schema/model3d.schema';

type SessionUser = {
  id: number;
  isModerator?: boolean | null;
};

// Mirrors `report.service.ts`'s status overrides — keep in lockstep.
const statusOverrides: Partial<Record<ReportReason, ReportStatus>> = {
  [ReportReason.NSFW]: ReportStatus.Actioned,
};

// Subset of fields we actually write to `Report`. The outer discriminated-union
// zod schema gives us `reason` + `details`. We strip the entity-id (`id`) out
// before persisting since it goes on the join row.
const buildReportData = (
  input: CreateModel3DReportInput | CreateModel3DReviewReportInput,
  userId: number
) => {
  const { reason } = input;
  // `details` is part of every variant of the discriminated union.
  const details = (input as { details?: unknown }).details;
  return {
    userId,
    reason,
    details: (details as object | undefined) ?? undefined,
    status: statusOverrides[reason] ?? ReportStatus.Pending,
  };
};

export const createModel3DReport = async ({
  input,
  user,
}: {
  input: CreateModel3DReportInput;
  user: SessionUser;
}) => {
  // CSAM reports are mod-only across the codebase — keep parity.
  if (input.reason === ReportReason.CSAM && !user.isModerator) {
    throw throwAuthorizationError();
  }

  const target = await dbRead.model3D.findUnique({
    where: { id: input.id },
    select: { id: true, deletedAt: true },
  });
  if (!target || target.deletedAt) {
    throw throwNotFoundError(`No 3D model with id ${input.id}`);
  }

  try {
    return await dbWrite.report.create({
      data: {
        ...buildReportData(input, user.id),
        model3d: {
          create: {
            model3dId: input.id,
          },
        },
      },
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const createModel3DReviewReport = async ({
  input,
  user,
}: {
  input: CreateModel3DReviewReportInput;
  user: SessionUser;
}) => {
  if (input.reason === ReportReason.CSAM && !user.isModerator) {
    throw throwAuthorizationError();
  }

  const target = await dbRead.model3DReview.findUnique({
    where: { id: input.id },
    select: { id: true },
  });
  if (!target) {
    throw throwNotFoundError(`No review with id ${input.id}`);
  }

  try {
    return await dbWrite.report.create({
      data: {
        ...buildReportData(input, user.id),
        model3dReview: {
          create: {
            model3dReviewId: input.id,
          },
        },
      },
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
