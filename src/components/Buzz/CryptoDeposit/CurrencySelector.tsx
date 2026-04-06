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
import { getFiatDisplay } from '~/components/Buzz/CryptoDeposit/crypto-deposit.constants';
import { useSupportedCurrencies } from '~/components/Buzz/CryptoDeposit/crypto-deposit.hooks';
import { FiatMenu } from '~/components/Buzz/CryptoDeposit/FiatMenu';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

// ── Hook: owns all currency selection state + queries ──

export type CurrencySelectionState = ReturnType<typeof useCurrencySelection>;

export function useCurrencySelection({
  selectedFiat,
  onFiatChange,
  onSelect,
}: {
  selectedFiat: string;
  onFiatChange: (fiat: string) => void;
  onSelect?: (code: string, chain: string) => void;
}) {
  const currentUser = useCurrentUser();
  const [selectedTicker, setSelectedTicker] = useState<string>('usdc');
  const [selectedCode, setSelectedCode] = useState<string>('USDCBASE');

  const { data: currencies, isLoading: loadingCurrencies } = useSupportedCurrencies();

  // Sync selectedCode when currencies load (hardcoded default may not match API codes)
  React.useEffect(() => {
    if (!currencies) return;
    const group = currencies.find((g) => g.ticker === selectedTicker);
    if (group && !group.networks.some((n) => n.code === selectedCode)) {
      const network = group.networks[0];
      setSelectedCode(network.code);
      onSelect?.(network.code, network.chain ?? 'evm');
    }
  }, [currencies, selectedTicker, selectedCode, onSelect]);

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
      const group = currencies?.find((g) => g.ticker === ticker);
      if (code) {
        setSelectedCode(code);
        const network = group?.networks.find((n) => n.code === code);
        onSelect?.(code, network?.chain ?? 'evm');
      } else if (group && group.networks.length > 0) {
        const network = group.networks[0];
        setSelectedCode(network.code);
        onSelect?.(network.code, network.chain ?? 'evm');
      }
    },
    [currencies, onSelect]
  );

  const { data: minData, isFetching: loadingMin } = trpc.nowPayments.getMinAmount.useQuery(
    { currencyCode: selectedCode, fiat: selectedFiat },
    { enabled: !!currentUser && !!selectedCode, staleTime: 60 * 1000 }
  );

  const networkLabel = useMemo(() => {
    if (!selectedGroup || selectedGroup.networks.length <= 1) return null;
    const raw = selectedNetwork?.network ?? selectedNetwork?.name ?? '';
    return getDisplayName(raw.toLowerCase());
  }, [selectedGroup, selectedNetwork]);

  return {
    currencies,
    loadingCurrencies,
    selectedTicker,
    selectedCode,
    selectedGroup,
    selectedNetwork,
    handleTickerChange,
    minData,
    loadingMin,
    networkLabel,
    selectedFiat,
    onFiatChange,
  };
}

// ── Presentational: currency badges ──

export function CurrencyBadges({ state }: { state: CurrencySelectionState }) {
  const { currencies, loadingCurrencies, selectedTicker, selectedCode, handleTickerChange } = state;

  if (loadingCurrencies) {
    return (
      <Group gap={4} wrap="wrap">
        {[50, 40, 55, 45, 60].map((w, i) => (
          <Skeleton key={i} height={26} width={w} radius="sm" />
        ))}
      </Group>
    );
  }

  return (
    <Group gap={4} wrap="wrap" role="group" aria-label="Select cryptocurrency">
      {(currencies ?? []).map((group) => {
        const isSelected = selectedTicker === group.ticker;
        const isMulti = group.networks.length > 1;

        if (isMulti) {
          return (
            <Menu key={group.ticker} withinPortal position="bottom-start" shadow="sm">
              <Menu.Target>
                <UnstyledButton>
                  <Badge
                    variant={isSelected ? 'filled' : 'light'}
                    color={isSelected ? 'blue' : 'gray'}
                    size="md"
                    radius="sm"
                    className="cursor-pointer"
                  >
                    {group.ticker.toUpperCase()}
                    <span className="ml-0.5 opacity-60">
                      ·{group.networks.length}
                    </span>
                  </Badge>
                </UnstyledButton>
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
          <UnstyledButton
            key={group.ticker}
            onClick={() => handleTickerChange(group.ticker)}
            aria-label={`Select ${group.ticker.toUpperCase()}`}
            aria-pressed={isSelected}
          >
            <Badge
              variant={isSelected ? 'filled' : 'light'}
              color={isSelected ? 'blue' : 'gray'}
              size="md"
              radius="sm"
              className="cursor-pointer"
            >
              {group.ticker.toUpperCase()}
            </Badge>
          </UnstyledButton>
        );
      })}
    </Group>
  );
}

// ── Presentational: min deposit line ──

export function MinDepositInfo({ state }: { state: CurrencySelectionState }) {
  const { selectedTicker, networkLabel, loadingMin, minData, selectedFiat, onFiatChange } = state;
  const { symbol: fiatSymbol } = getFiatDisplay(selectedFiat);

  return (
    <Group gap={4} align="center">
      <Text component="div" size="xs" c="dimmed">
        Minimum {selectedTicker.toUpperCase()} deposit
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
        <FiatMenu selectedFiat={selectedFiat} onFiatChange={onFiatChange} />
      </Text>
    </Group>
  );
}

// ── Legacy combined component (kept for backward compat if needed) ──

export function CurrencySelector({
  selectedFiat: controlledFiat,
  onFiatChange,
  onSelect,
}: {
  selectedFiat?: string;
  onFiatChange?: (fiat: string) => void;
  onSelect?: (code: string, chain: string) => void;
} = {}) {
  const [internalFiat, setInternalFiat] = useState<string>('usd');
  const selectedFiat = controlledFiat ?? internalFiat;
  const handleFiatChange = (fiat: string) => {
    setInternalFiat(fiat);
    onFiatChange?.(fiat);
  };

  const state = useCurrencySelection({ selectedFiat, onFiatChange: handleFiatChange, onSelect });

  return (
    <Stack gap={6}>
      <CurrencyBadges state={state} />
      <MinDepositInfo state={state} />
    </Stack>
  );
}
