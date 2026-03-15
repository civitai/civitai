import { Menu, Text, UnstyledButton } from '@mantine/core';
import { FIAT_OPTIONS, FIAT_SYMBOLS } from '~/components/Buzz/CryptoDeposit/crypto-deposit.constants';

/**
 * Inline fiat-currency picker rendered as a "USD ▾" dropdown.
 * Used in both the CurrencySelector (min-deposit row) and the
 * DepositCardContent (conversion-rate panel).
 */
export function FiatMenu({
  selectedFiat,
  onFiatChange,
  size = 'xs',
  fw,
}: {
  selectedFiat: string;
  onFiatChange: (fiat: string) => void;
  /** Text size for the trigger label. */
  size?: string;
  /** Font weight for the trigger label. */
  fw?: number;
}) {
  const fiatLabel = FIAT_OPTIONS.find((f) => f.value === selectedFiat)?.label ?? 'USD';

  return (
    <Menu position="bottom-start" withinPortal shadow="sm">
      <Menu.Target>
        <UnstyledButton className="inline-flex items-center" aria-label={`Change display currency, currently ${fiatLabel}`}>
          <Text span size={size} c="blue" className="cursor-pointer" fw={fw}>
            {fiatLabel} ▾
          </Text>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {FIAT_OPTIONS.map((opt) => (
          <Menu.Item
            key={opt.value}
            onClick={() => onFiatChange(opt.value)}
            fw={selectedFiat === opt.value ? 600 : undefined}
          >
            {FIAT_SYMBOLS[opt.value]} {opt.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
