import randomstring from 'randomstring';
import { dbRead, dbWrite } from '~/server/db/client';
import { isModerator } from '~/server/routers/base.router';
import { throwBadRequestError } from '~/server/utils/errorHandling';

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
    const user = await dbRead.user.findUniqueOrThrow({ where: { id: userId } });
    const generateString = (length = 3) =>
      randomstring.generate({
        length,
        charset: 'alphabetic',
        capitalization: 'uppercase',
      });
    const generateCode = () => {
      return user.username && user.username.length >= 3
        ? `${user.username.slice(0, 3).toUpperCase()}-${generateString()}`
        : `${generateString()}-${generateString()}}`;
    };

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
  const userReferralCode = await dbRead.userReferralCode.findUniqueOrThrow({ where: { id } });

  if (userReferralCode.userId !== userId && !isModerator) {
    throw throwBadRequestError('You do not have permission to delete this referral code');
  }

  return await dbWrite.userReferralCode.update({ where: { id }, data: { deletedAt: new Date() } });
};
