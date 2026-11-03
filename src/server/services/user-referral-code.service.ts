import { dbRead, dbWrite } from '~/server/db/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import { isModerator } from '~/server/routers/base.router';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { generateReferralCode } from '~/server/utils/referral-code';

export const getUserReferralCodes = async ({
  userId,
  includeCount,
}: {
  userId: number;
  includeCount: boolean;
}) => {
  return await dbRead.userReferralCode.findMany({
    where: { userId, deletedAt: null },
    select: {
      id: true,
      code: true,
      note: true,
      _count: includeCount
        ? {
            select: {
              referees: true,
            },
          }
        : undefined,
    },
  });
};

export const upsertUserReferralCode = async ({
  id,
  note,
  code,
  userId,
  isModerator,
}: {
  id?: number;
  userId: number;
  note?: string | null;
  code?: string;
  isModerator?: boolean;
}) => {
  if (id) {
    return await dbWrite.userReferralCode.update({
      where: { id },
      data: {
        userId,
        note,
        code: isModerator && code ? code : undefined,
      },
    });
  } else {
    const findArgs = { where: { id: userId } } as const;
    const user = await dbRead.user.findUniqueOrThrow(findArgs).catch(() => {
      dbReadFallbackCounter.inc({ entity: 'user', caller: 'upsertUserReferralCode' });
      return dbWrite.user.findUniqueOrThrow(findArgs);
    });
    const generateCode = () => generateReferralCode(user.username);

    let generatedCode = generateCode();
    let maxAttempts = 3;

    while (maxAttempts > 0) {
      const codeExists = await dbRead.userReferralCode.findUnique({
        where: { code: generatedCode },
      });

      if (!codeExists) {
        break;
      }

      generatedCode = generateCode();
      maxAttempts--;

      if (maxAttempts <= 0 && !(isModerator && code)) {
        throw throwBadRequestError('Could not generate a code for this user');
      }
    }

    code = isModerator ? code || generatedCode : generatedCode;

    return await dbWrite.userReferralCode.create({
      data: {
        userId,
        note,
        code,
      },
    });
  }
};
export const deleteUserReferralCode = async ({
  id,
  userId,
  isModerator,
}: {
  id: number;
  userId: number;
  isModerator?: boolean;
}) => {
  const referralCodeFindArgs = { where: { id } } as const;
  const userReferralCode = await dbRead.userReferralCode
    .findUniqueOrThrow(referralCodeFindArgs)
    .catch(() => {
      dbReadFallbackCounter.inc({ entity: 'userReferralCode', caller: 'deleteUserReferralCode' });
      return dbWrite.userReferralCode.findUniqueOrThrow(referralCodeFindArgs);
    });

  if (userReferralCode.userId !== userId && !isModerator) {
    throw throwBadRequestError('You do not have permission to delete this referral code');
  }

  return await dbWrite.userReferralCode.update({ where: { id }, data: { deletedAt: new Date() } });
};
