import dayjs from 'dayjs';
import {
  EXTRACTION_FEES,
  EXTRACTION_PHASE_DURATION,
  PayoutMethods,
  WITHDRAWAL_FEES,
} from '~/shared/constants/creator-program.constants';

export function getForecastedValue(
  toBank: number,
  pool: { size: { forecasted: number }; value: number }
) {
  return (toBank / pool.size.forecasted) * pool.value;
}

export function getCurrentValue(
  toBank: number,
  pool: { size: { forecasted: number }; value: number }
) {
  if (pool.value === 0) return 0;

  return (toBank / pool.value) * pool.value;
}

export async function getExtractionFee(toExtract: number): Promise<number> {
  let fee = 0;
  let remaining = toExtract;

  for (const { min, max, fee: rate } of EXTRACTION_FEES) {
    if (remaining <= 0) break;

    const taxableAmount = Math.min(remaining, max - min);
    fee += taxableAmount * rate;
    remaining -= taxableAmount;
  }

  return fee;
}

export function getPhases(month?: Date) {
  month ??= new Date();
  const dayjsMonth = dayjs(month);

  const bank = [
    dayjsMonth.startOf('month').toDate(),
    dayjsMonth.endOf('month').subtract(EXTRACTION_PHASE_DURATION, 'days').toDate(),
  ];
  const extraction = [bank[1], dayjsMonth.endOf('month').subtract(1, 'hours').toDate()];

  return { bank, extraction };
}

export function getWithdrawalFee(amount: number, method: PayoutMethods) {
  const { type, amount: fee } = WITHDRAWAL_FEES[method];
  return type === 'percent' ? amount * fee : fee;
}
