import { RedeemableCodeType } from '@prisma/client';

import { dbWrite } from '~/server/db/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import {
  ConsumeRedeemableCodeInput,
  CreateRedeemableCodeInput,
  DeleteRedeemableCodeInput,
} from '~/server/schema/redeemableCode.schema';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { throwDbCustomError, withRetries } from '~/server/utils/errorHandling';
import { generateToken } from '~/utils/string-helpers';

export async function createRedeemableCodes({
  unitValue,
  type,
  expiresAt,
  quantity = 1,
}: CreateRedeemableCodeInput) {
  const codes = Array.from({ length: quantity }, () => {
    const code = `CS-${generateToken(4)}-${generateToken(4)}`.toUpperCase();
    return { code, unitValue, expiresAt, type };
  });
  await dbWrite.redeemableCode.createMany({ data: codes });
  return codes.map((code) => code.code);
}

export function deleteRedeemableCode({ code }: DeleteRedeemableCodeInput) {
  return dbWrite.redeemableCode
    .delete({
      where: { code, redeemedAt: null },
    })
    .catch(throwDbCustomError('Code does not exists or has been redeemed'));
}

export async function consumeRedeemableCode({
  code,
  userId,
}: ConsumeRedeemableCodeInput & { userId: number }) {
  const consumedCode = await dbWrite.redeemableCode
    .update({
      where: {
        code,
        redeemedAt: null,
        OR: [{ expiresAt: { gt: new Date() } }, { expiresAt: null }],
      },
      data: { redeemedAt: new Date(), userId },
      select: { code: true, unitValue: true, type: true, userId: true },
    })
    .catch(throwDbCustomError('Code does not exists, has been redeemed, or has expired'));

  if (consumedCode.type === RedeemableCodeType.Buzz) {
    const transactionId = `redeemable-code-${consumedCode.code}`;

    await withRetries(() =>
      createBuzzTransaction({
        fromAccountId: 0,
        toAccountId: consumedCode.userId as number,
        amount: consumedCode.unitValue,
        description: `Redeemed code ${consumedCode.code}`,
        type: TransactionType.Redeemable,
        externalTransactionId: transactionId,
      })
    );

    await dbWrite.redeemableCode.update({
      where: { code },
      data: { transactionId },
    });
  } else if (consumedCode.type === RedeemableCodeType.Membership) {
    // Do membership stuff
  }

  return consumedCode;
}
