import type React from 'react';

/** Fiat currency option used across crypto deposit UI. */
export type FiatOption = { value: string; label: string; symbol: string };

export const FIAT_OPTIONS: FiatOption[] = [
  { value: 'usd', label: 'USD', symbol: '$' },
  { value: 'eur', label: 'EUR', symbol: '€' },
  { value: 'gbp', label: 'GBP', symbol: '£' },
  { value: 'cad', label: 'CAD', symbol: 'C$' },
  { value: 'aud', label: 'AUD', symbol: 'A$' },
  { value: 'jpy', label: 'JPY', symbol: '¥' },
  { value: 'brl', label: 'BRL', symbol: 'R$' },
];

/** Quick lookup: fiat code -> symbol (e.g. "usd" -> "$") */
export const FIAT_SYMBOLS: Record<string, string> = Object.fromEntries(
  FIAT_OPTIONS.map((f) => [f.value, f.symbol])
);

/** Resolve symbol and label for a fiat code. */
export function getFiatDisplay(fiatCode: string) {
  const opt = FIAT_OPTIONS.find((f) => f.value === fiatCode);
  return {
    symbol: opt?.symbol ?? fiatCode.toUpperCase(),
    label: opt?.label ?? fiatCode.toUpperCase(),
  };
}

/** Shared card background style for the elevated "outer card" pattern. */
export const outerCardStyle: React.CSSProperties = {
  background: 'light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))',
  boxShadow: 'light-dark(0 1px 3px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.5))',
};
