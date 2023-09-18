import randomstring from 'randomstring';
import { dbRead, dbWrite } from '~/server/db/client';

export const getUserReferralCodes = async ({ userId }: { userId: number }) => {
  return await dbRead.userReferralCode.findMany({
    where: { userId },
    select: {
      id: true,
      code: true,
      note: true,
    },
  });
};

export const createUserReferralCode = async ({
  userId,
  note,
  code,
}: {
  userId: number;
  note?: string;
  code?: string;
}) => {
  const user = await dbRead.user.findUniqueOrThrow({ where: { id: userId } });
  const generateString = (length = 3) =>
    randomstring.generate({
      length,
      charset: 'alphabetic',
      capitalization: 'uppercase',
    });

  code =
    code ||
    (user.username && user.username.length >= 3
      ? `${user.username.slice(0, 3).toUpperCase()}-${generateString()}`
      : `${generateString()}-${generateString()}}`);

  return await dbWrite.userReferralCode.create({
    data: {
      userId,
      note,
      code,
    },
  });
};
