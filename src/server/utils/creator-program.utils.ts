import dayjs from '~/shared/utils/dayjs';
import {
  EXTRACTION_FEES,
  EXTRACTION_PHASE_DURATION,
  WITHDRAWAL_FEES,
} from '~/shared/constants/creator-program.constants';
import type { CashWithdrawalMethod } from '~/shared/utils/prisma/enums';

// Compensation-pool value math now lives in @civitai/buzz (shared with the creator-studio spoke); re-exported
// here so existing `~/server/utils/creator-program.utils` import sites are unchanged. Single source of truth.
export { getForecastedValue, getCurrentValue } from '@civitai/buzz';

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

export type CreatorProgramStageNotification =
  | 'banking-phase-ending'
  | 'extraction-phase-started'
  | 'extraction-phase-ending';

const utcDay = (date: Date | ReturnType<typeof dayjs.utc>) => dayjs.utc(date).format('YYYY-MM-DD');

// The UTC calendar day each stage notification belongs to, derived from getPhases so the
// send day cannot drift from the phases users actually see.
export function getStageNotificationDays(
  month?: Date
): Record<CreatorProgramStageNotification, string> {
  const { bank, extraction } = getPhases({ month });
  return {
    // ±1ms keeps the day right whether a boundary is an inclusive 23:59:59.999 or an exclusive midnight.
    'banking-phase-ending': utcDay(dayjs.utc(bank[1]).subtract(1, 'ms')),
    'extraction-phase-started': utcDay(dayjs.utc(extraction[0]).add(1, 'ms')),
    'extraction-phase-ending': utcDay(extraction[1]),
  };
}

export function isStageNotificationDay(stage: CreatorProgramStageNotification, now = new Date()) {
  return getStageNotificationDays(now)[stage] === utcDay(now);
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
  const availableDate = dayjs('2024-03-01').utc().startOf('month');

  return {
    isAvailable: isModerator || dayjs().isAfter(availableDate),
    availableDate: availableDate.toDate(),
  };
};
