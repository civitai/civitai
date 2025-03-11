import { constants } from '~/server/common/constants';
import { Currency } from '~/shared/utils/prisma/enums';

/**
 * @see https://gist.github.com/zentala/1e6f72438796d74531803cc3833c039c
 * @returns The file size in human-readable format
 */
export const KB = 1024 as const;

export function bytesToKB(bytes: number): number {
  return bytes / KB;
}

export const formatKBytes = (kb: number, decimals = 2) => formatBytes(kb * KB, decimals);
export function formatBytes(bytes: number, decimals = 2) {
  if (bytes <= 0) return '0 Bytes';

  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(KB));

  return parseFloat((bytes / Math.pow(KB, i)).toFixed(decimals)) + ' ' + sizes[i];
}

export function formatToLeastDecimals(value: number, decimals = 2) {
  return parseFloat(value.toFixed(decimals));
}

export function asOrdinal(n: number) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const value = n % 100;

  // Handle special cases like 11th, 12th, 13th
  if (value >= 11 && value <= 13) {
    return n + 'th';
  }

  // Use the last digit to determine the suffix
  const lastDigit = n % 10;
  return n + (suffixes[lastDigit] || 'th');
}

export function asOrdinalSuffix(n: number) {
  const val = asOrdinal(n);
  return val.slice(-2);
}

export function formatSeconds(seconds: number) {
  if (seconds === 0) return '0 seconds';

  const units = [
    { name: 'year', limit: 31536000, in_seconds: 31536000 },
    { name: 'month', limit: 2592000, in_seconds: 2592000 },
    { name: 'week', limit: 604800, in_seconds: 604800 },
    { name: 'day', limit: 86400, in_seconds: 86400 },
    { name: 'hour', limit: 3600, in_seconds: 3600 },
    { name: 'minute', limit: 60, in_seconds: 60 },
    { name: 'second', limit: 1, in_seconds: 1 },
  ];
  let output = '';
  let unit: (typeof units)[number];
  let unitCount: number;
  for (let i = 0; i < units.length; i++) {
    unit = units[i];
    unitCount = Math.floor(seconds / unit.in_seconds);
    if (unitCount >= 1) {
      output += ' ' + unitCount + ' ' + unit.name + (unitCount > 1 ? 's' : '');
      seconds -= unitCount * unit.in_seconds;
    }
  }
  return output.trim();
}

export function abbreviateNumber(
  value: number,
  opts?: { decimals?: number; floor?: boolean }
): string {
  if (!value) return '0';

  const { decimals, floor } = opts ?? { decimals: 1 };
  const suffixes = ['', 'k', 'm', 'b', 't'];
  let index = 0;

  while (value >= 1000 && index < suffixes.length - 1) {
    value /= 1000;
    index++;
  }

  if (floor) {
    value = Math.floor(value);
  }

  const formattedValue =
    Math.round(value * Math.pow(10, decimals ?? 0)) / Math.pow(10, decimals ?? 0);

  return `${formattedValue}${suffixes[index]}`;
}

export function getRandomInt(min: number, max: number) {
  const intMin = Math.ceil(min);
  const intMax = Math.floor(max);
  return Math.floor(Math.random() * (intMax - intMin + 1)) + intMin;
}

export function numberWithCommas(value: number | string | undefined) {
  return value != null && !Number.isNaN(typeof value === 'string' ? parseFloat(value) : value)
    ? `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : '';
}

export function formatPriceForDisplay(
  value: number | undefined,
  currency?: Currency,
  opts?: { decimals: boolean }
) {
  if (currency === Currency.BUZZ) {
    return numberWithCommas(value);
  }

  if (!value) {
    return `0.00`;
  }

  const [intPart, decimalPart] = (value / 100).toFixed(2).split('.');

  if (opts && !opts?.decimals && decimalPart === '00') {
    return `${numberWithCommas(intPart)}`;
  }

  return `${numberWithCommas(intPart)}.${decimalPart}`;
}

export function isNumeric(value?: unknown) {
  return !isNaN(Number(value));
}

export const findClosest = (array: number[], target: number) => {
  return array.reduce((a, b) => {
    return Math.abs(b - target) < Math.abs(a - target) ? b : a;
  });
};

export const formatCurrencyForDisplay = (
  value: number,
  currency?: Currency,
  opts?: { decimals?: boolean }
) => {
  if (!currency) {
    numberWithCommas(value);
  }

  if (currency === Currency.BUZZ) {
    return numberWithCommas(value);
  }

  const [intPart, decimalPart] = (value / 100).toFixed(2).split('.');

  if (opts && !opts?.decimals && decimalPart === '00') {
    return `${numberWithCommas(intPart)}`;
  }

  return `${numberWithCommas(intPart)}.${decimalPart}`;
};

export const getBuzzWithdrawalDetails = (buzzAmount: number, platformFeeRate?: number) => {
  if (!platformFeeRate) {
    platformFeeRate = constants.buzz.platformFeeRate;
  }
  const dollarAmount = Math.round((buzzAmount / constants.buzz.buzzDollarRatio) * 100);
  const platformFee = Math.round(dollarAmount * (platformFeeRate / 10000));
  const payoutAmount = dollarAmount - platformFee;

  return {
    dollarAmount,
    platformFee,
    payoutAmount,
  };
};

const ONE_MINUTE = 60;
const ONE_HOUR = 60 * ONE_MINUTE;
export const formatDuration = (seconds: number) => {
  if (seconds === 0) return '0:00';

  const hours = Math.floor(seconds / ONE_HOUR);
  const minutes = Math.floor((seconds % ONE_HOUR) / ONE_MINUTE);
  const remainingSeconds = Math.round(seconds % ONE_MINUTE);

  const hourString = hours > 0 ? String(hours).padStart(2, '0') : '';
  const minuteString =
    hourString || minutes === 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const secondString = String(remainingSeconds).padStart(2, '0');

  return [hourString, minuteString, secondString].filter(Boolean).join(':');
};

// Help from ChatGPT :^) -Manuel
export function roundDownToPowerOfTwo(value: number) {
  if (value < 1) return 0; // Powers of 2 start from 1 in practical use cases

  // Check if the value is already a power of 2
  if ((value & (value - 1)) === 0) return value;

  // Round down to the nearest power of 2 using bit shifting
  let result = 1;
  while (result <= value) {
    result <<= 1; // Double the result (equivalent to result *= 2)
  }

  return result >> 1; // Divide by 2 to get the largest power of 2 less than or equal to the value
}
