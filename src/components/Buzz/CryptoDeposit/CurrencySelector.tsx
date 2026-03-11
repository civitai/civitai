import {
  Badge,
  Group,
  Menu,
  Skeleton,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import React, { useCallback, useMemo, useState } from 'react';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const FIAT_OPTIONS = [
  { value: 'usd', label: 'USD' },
  { value: 'eur', label: 'EUR' },
  { value: 'gbp', label: 'GBP' },
  { value: 'cad', label: 'CAD' },
  { value: 'aud', label: 'AUD' },
  { value: 'jpy', label: 'JPY' },
  { value: 'brl', label: 'BRL' },
];

const FIAT_SYMBOLS: Record<string, string> = {
  usd: '$',
  eur: '€',
  gbp: '£',
  cad: 'C$',
  aud: 'A$',
  jpy: '¥',
  brl: 'R$',
};

export function CurrencySelector({
  selectedFiat: controlledFiat,
  onFiatChange,
}: {
  selectedFiat?: string;
  onFiatChange?: (fiat: string) => void;
} = {}) {
  const [selectedTicker, setSelectedTicker] = useState<string>('usdc');
  const [selectedCode, setSelectedCode] = useState<string>('USDCBASE');
  const [internalFiat, setInternalFiat] = useState<string>('usd');

  const selectedFiat = controlledFiat ?? internalFiat;
  const handleFiatChange = (fiat: string) => {
    setInternalFiat(fiat);
    onFiatChange?.(fiat);
  };

  const { data: currencies, isLoading: loadingCurrencies } =
    trpc.nowPayments.getSupportedCurrencies.useQuery(undefined, { staleTime: 5 * 60 * 1000 });

  // Sync selectedCode when currencies load (hardcoded default may not match API codes)
  React.useEffect(() => {
    if (!currencies) return;
    const group = currencies.find((g) => g.ticker === selectedTicker);
    if (group && !group.networks.some((n) => n.code === selectedCode)) {
      setSelectedCode(group.networks[0].code);
    }
  }, [currencies, selectedTicker, selectedCode]);

  const selectedGroup = useMemo(
    () => currencies?.find((g) => g.ticker === selectedTicker) ?? null,
    [currencies, selectedTicker]
  );

  const selectedNetwork = useMemo(
    () => selectedGroup?.networks.find((n) => n.code === selectedCode) ?? null,
    [selectedGroup, selectedCode]
  );

  const handleTickerChange = useCallback(
    (ticker: string, code?: string) => {
      setSelectedTicker(ticker);
      if (code) {
        setSelectedCode(code);
      } else {
        const group = currencies?.find((g) => g.ticker === ticker);
        if (group && group.networks.length > 0) {
          setSelectedCode(group.networks[0].code);
        }
      }
    },
    [currencies]
  );

  const { data: minData, isFetching: loadingMin } = trpc.nowPayments.getMinAmount.useQuery(
    { currencyCode: selectedCode, fiat: selectedFiat },
    { enabled: !!selectedCode, staleTime: 60 * 1000 }
  );

  const fiatSymbol = FIAT_SYMBOLS[selectedFiat] ?? selectedFiat.toUpperCase();
  const fiatLabel = FIAT_OPTIONS.find((f) => f.value === selectedFiat)?.label ?? 'USD';

  const networkLabel = useMemo(() => {
    if (!selectedGroup || selectedGroup.networks.length <= 1) return null;
    const raw = selectedNetwork?.network ?? selectedNetwork?.name ?? '';
    return getDisplayName(raw.toLowerCase());
  }, [selectedGroup, selectedNetwork]);

  if (loadingCurrencies) {
    return (
      <Stack gap={6}>
        <Group gap={4} wrap="wrap">
          {[50, 40, 55, 45, 60].map((w, i) => (
            <Skeleton key={i} height={22} width={w} radius="sm" />
          ))}
        </Group>
        <Skeleton height={14} width={180} radius="sm" />
      </Stack>
    );
  }

  return (
    <Stack gap={6}>
      {/* Currency badges */}
      <Group gap={4} wrap="wrap">
        {(currencies ?? []).map((group) => {
          const isSelected = selectedTicker === group.ticker;
          const isMulti = group.networks.length > 1;

          if (isMulti) {
            return (
              <Menu key={group.ticker} withinPortal position="bottom-start" shadow="sm">
                <Menu.Target>
                  <Badge
                    variant={isSelected ? 'filled' : 'light'}
                    color={isSelected ? 'blue' : 'gray'}
                    size="sm"
                    radius="sm"
                    className="cursor-pointer"
                  >
                    {group.ticker.toUpperCase()}
                    <Text component="span" size="xs" ml={2} style={{ opacity: 0.6 }}>
                      ·{group.networks.length}
                    </Text>
                  </Badge>
                </Menu.Target>
                <Menu.Dropdown>
                  {group.networks.map((network) => {
                    const netKey = (network.network ?? '').toLowerCase();
                    const netName = getDisplayName(netKey) || network.network || network.name;
                    return (
                      <Menu.Item
                        key={network.code}
                        fw={selectedCode === network.code ? 700 : undefined}
                        onClick={() => handleTickerChange(group.ticker, network.code)}
                      >
                        {netName}
                      </Menu.Item>
                    );
                  })}
                </Menu.Dropdown>
              </Menu>
            );
          }

          return (
            <Badge
              key={group.ticker}
              variant={isSelected ? 'filled' : 'light'}
              color={isSelected ? 'blue' : 'gray'}
              size="sm"
              radius="sm"
              className="cursor-pointer"
              onClick={() => handleTickerChange(group.ticker)}
            >
              {group.ticker.toUpperCase()}
            </Badge>
          );
        })}
      </Group>

      {/* Min deposit */}
      <Group gap={4} align="center">
        <Text size="xs" c="dimmed">
          Min {selectedTicker.toUpperCase()} deposit
          {networkLabel ? ` on ${networkLabel}` : ''}
          :{' '}
          {loadingMin ? (
            <Skeleton height={12} width={40} radius="sm" className="inline-block align-middle" />
          ) : minData?.fiatEquivalent != null ? (
            <Text span fw={600}>
              {fiatSymbol}
              {(Math.ceil(minData.fiatEquivalent * 100) / 100).toFixed(2)}
            </Text>
          ) : null}
          {' '}
          <Menu position="bottom-start" withinPortal shadow="sm">
            <Menu.Target>
              <UnstyledButton className="inline-flex items-center">
                <Text span size="xs" c="blue" className="cursor-pointer">
                  {fiatLabel} ▾
                </Text>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              {FIAT_OPTIONS.map((opt) => (
                <Menu.Item
                  key={opt.value}
                  onClick={() => handleFiatChange(opt.value)}
                  fw={selectedFiat === opt.value ? 600 : undefined}
                >
                  {FIAT_SYMBOLS[opt.value]} {opt.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        </Text>
      </Group>
    </Stack>
  );
}
