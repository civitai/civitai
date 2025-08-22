import dayjs from '~/shared/utils/dayjs';
import {
  EXTRACTION_FEES,
  EXTRACTION_PHASE_DURATION,
  WITHDRAWAL_FEES,
} from '~/shared/constants/creator-program.constants';
import type { CashWithdrawalMethod } from '~/shared/utils/prisma/enums';

export function getForecastedValue(
  toBank: number,
  pool: { size: { forecasted: number }; value: number }
) {
  // toBank / 1000 ensures we cap at $1 per 1000 buzz
  return Math.min((toBank / pool.size.forecasted) * pool.value, toBank / 1000);
}

export function getCurrentValue(
  toBank: number,
  pool: { size: { forecasted: number; current: number }; value: number }
) {
  if (pool.size.current === 0) return 0;

  // toBank / 1000 ensures we cap at $1 per 1000 buzz
  return Math.min((toBank / pool.size.current) * pool.value, toBank / 1000);
}

export function getExtractionFee(toExtract: number): number {
  let fee = 0;
  let remaining = toExtract;

  for (const { min, max, fee: rate } of EXTRACTION_FEES) {
    if (remaining <= 0) break;

    const taxableAmount = max ? Math.min(remaining, max - min) : remaining;
    fee += taxableAmount * rate;
    remaining -= taxableAmount;
  }

  return Math.round(fee);
}

export function getPhases({ month, flip }: { month?: Date; flip?: boolean } = {}) {
  month ??= new Date();
  const dayjsMonth = dayjs.utc(month);

  const bank = [
    dayjsMonth.startOf('month').toDate(),
    dayjsMonth.endOf('month').subtract(EXTRACTION_PHASE_DURATION, 'days').toDate(),
  ];
  const extraction = [bank[1], dayjsMonth.endOf('month').subtract(1, 'hours').toDate()];

  return { bank: flip ? extraction : bank, extraction: flip ? bank : extraction };
}

export function getWithdrawalFee(amount: number, method: CashWithdrawalMethod) {
  const withDrawalFees = WITHDRAWAL_FEES[method];
  if (!withDrawalFees) {
    return 0;
  }
  const { type, amount: fee } = withDrawalFees;
  return type === 'percent' ? amount * fee : fee;
}

export function getWithdrawalRefCode(id: string, userId: number) {
  return `CW${userId}_${id}`.slice(0, 16); // Tipalti only supports 16 characters.....
}

/**
 * Parses a Tipalti withdrawal request ID to the user ID and the ID part of the cash withdrawal ID.
 * Always use these 2 to identify a cash withdrawal.
 *
 * @param refCode Tipalti withdrawal request ID
 * @returns  The user ID and the ID part of the cash withdrawal ID.
 */
export function parseRefCodeToWithdrawalId(refCode: string) {
  const pattern = /^CW(\d+)_?(\w+)$/;

  const match = refCode.match(pattern);
  if (!match) {
    throw new Error(`Invalid withdrawal ref code: ${refCode}`);
  }

  return {
    userId: Number(match[1]),
    idPart: match[2],
  };
}

export const getCreatorProgramAvailability = (isModerator = false) => {
  // 2 - March.
  const availableDate = dayjs().utc().set('month', 2).startOf('month');

  return {
    isAvailable: isModerator || dayjs().isAfter(availableDate),
    availableDate: availableDate.toDate(),
  };
};
