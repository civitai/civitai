import { dbRead, dbWrite } from '~/server/db/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
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

const REFERRAL_CODE_NOT_FOUND = 'Referral code not found';

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
    const where = { id, ...(isModerator ? {} : { userId }) };
    // Never writes userId: an update must not move a code to another account, a moderator's included.
    const data = { note, code: isModerator && code ? code : undefined };
    // Prisma answers count 0, without querying, when no field is set; look the row up instead.
    if (data.note === undefined && data.code === undefined) {
      // primary: same view of the row as the scoped write below
      const row = await dbWrite.userReferralCode.findFirst({ where });
      if (!row) throw throwNotFoundError(REFERRAL_CODE_NOT_FOUND);
      return row;
    }
    const { count } = await dbWrite.userReferralCode.updateMany({ where, data });
    // Same answer for a missing id and someone else's, so the error does not reveal which ids exist.
    if (!count) throw throwNotFoundError(REFERRAL_CODE_NOT_FOUND);
    // primary: read-your-write of the row just updated
    return await dbWrite.userReferralCode.findUniqueOrThrow({ where: { id } });
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
  const { count } = await dbWrite.userReferralCode.updateMany({
    where: { id, deletedAt: null, ...(isModerator ? {} : { userId }) },
    data: { deletedAt: new Date() },
  });
  if (!count) throw throwNotFoundError(REFERRAL_CODE_NOT_FOUND);
  // primary: read-your-write of the row just updated
  return await dbWrite.userReferralCode.findUniqueOrThrow({ where: { id } });
};
