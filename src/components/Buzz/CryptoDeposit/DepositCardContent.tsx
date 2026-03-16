import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBolt,
  IconCheck,
  IconCoins,
  IconCopy,
  IconCurrencyBitcoin,
  IconWallet,
} from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DepositCardProps } from './DepositAddressCard';
import {
  CurrencyBadges,
  MinDepositInfo,
  useCurrencySelection,
} from '~/components/Buzz/CryptoDeposit/CurrencySelector';
import { getFiatDisplay, outerCardStyle } from '~/components/Buzz/CryptoDeposit/crypto-deposit.constants';
import { FiatMenu } from '~/components/Buzz/CryptoDeposit/FiatMenu';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import {
  useCurrentUserSettings,
  useMutateUserSettings,
} from '~/components/UserSettings/hooks';
import { getChainDisplayName, getNetworkDisplayName } from '~/server/common/chain-config';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const QRCodeSVG = dynamic(() => import('qrcode.react').then((mod) => mod.QRCodeSVG), {
  ssr: false,
  loading: () => <div style={{ height: 150, width: 150 }} />,
});

export function DepositCardContent({ depositAddress, error, loading, onRetry, chain, onCurrencySelect }: DepositCardProps) {
  const clipboard = useClipboard({ timeout: 2000 });
  const userSettings = useCurrentUserSettings();
  const updateSettings = useMutateUserSettings();
  const [selectedFiat, setSelectedFiat] = useState('usd');

  // Track if chain changed after user copied address
  const [copiedChain, setCopiedChain] = useState<string | null>(null);
  const chainChangedAfterCopy = copiedChain != null && copiedChain !== chain;

  // Spotlight effect — uses refs + direct DOM manipulation to avoid re-renders on mouse move
  const spotlightRef = useRef<HTMLDivElement>(null);
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = spotlightRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.background = `radial-gradient(400px circle at ${x}px ${y}px, light-dark(rgba(0,0,0,0.02), rgba(255,255,255,0.04)), transparent 70%)`;
    el.style.opacity = '1';
  }, []);
  const handleMouseLeave = useCallback(() => {
    const el = spotlightRef.current;
    if (el) el.style.opacity = '0';
  }, []);

  // Sync from saved user preference on load
  useEffect(() => {
    if (userSettings.preferredFiatCurrency) {
      setSelectedFiat(userSettings.preferredFiatCurrency);
    }
  }, [userSettings.preferredFiatCurrency]);

  // Ref to avoid unstable dependency — updateSettings object identity changes each render
  const updateSettingsRef = useRef(updateSettings);
  updateSettingsRef.current = updateSettings;

  const handleFiatChange = useCallback((fiat: string) => {
    setSelectedFiat(fiat);
    updateSettingsRef.current.mutate({ preferredFiatCurrency: fiat });
  }, []);

  // Single source of truth for currency selection
  const currencyState = useCurrencySelection({
    selectedFiat,
    onFiatChange: handleFiatChange,
    onSelect: onCurrencySelect,
  });

  const { data: conversionRate, isFetching: loadingRate } =
    trpc.nowPayments.getBuzzConversionRate.useQuery(
      { fiat: selectedFiat },
      { staleTime: 60 * 1000 }
    );

  const isEmpty = !depositAddress;
  const { symbol: fiatSymbol } = getFiatDisplay(selectedFiat);

  // Build chain badge label: "Ethereum — Base" for multi-network chains, "Bitcoin" for single-network
  const chainLabel = (() => {
    const chainName = getChainDisplayName(chain);
    const networkCode = currencyState.selectedNetwork?.network;
    if (!networkCode) return chainName;
    const networkName = getNetworkDisplayName(networkCode);
    // Only show network suffix for multi-network chains where network differs from chain name
    if (currencyState.selectedGroup && currencyState.selectedGroup.networks.length > 1 && networkName !== chainName) {
      return `${chainName} — ${networkName}`;
    }
    return chainName;
  })();

  // rate = fiat per 1 USDC. 1 USDC = 1000 Buzz. So 1000 Buzz = rate fiat units.
  const buzzPrice = conversionRate?.rate != null ? conversionRate.rate : null;

  return (
    <Paper
      radius="md"
      withBorder
      style={{
        overflow: 'hidden',
        ...outerCardStyle,
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-[55%_45%]">
        {/* ── Right info panel with spotlight effect ── */}
        <div
          className="order-last relative overflow-hidden border-t border-gray-200 dark:border-white/5 sm:border-t-0 sm:border-l bg-gradient-to-br from-blue-500/5 to-yellow-500/5 dark:from-blue-500/[0.06] dark:to-yellow-500/[0.06]"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {/* Spotlight glow — styled via ref to avoid re-renders */}
          <div
            ref={spotlightRef}
            className="absolute inset-0 pointer-events-none transition-opacity duration-500"
            style={{ opacity: 0 }}
          />

          {/* Accent border */}
          <div className="absolute left-0 top-[10%] bottom-[10%] w-[3px] rounded-sm bg-gradient-to-b from-blue-500 to-yellow-500 z-[1]" />

          <Stack gap="md" p="lg" pl="xl" className="relative z-[1]">
            {/* Conversion rate — most prominent */}
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.08em' }}>
                Conversion rate
              </Text>
              <Group gap={6} align="center">
                <CurrencyIcon currency="BUZZ" size={22} />
                <Text fw={800} size="xl" style={{ lineHeight: 1 }}>
                  1,000
                </Text>
                <Text c="dimmed" size="sm" fw={500}>
                  Buzz
                </Text>
                <Text c="dimmed" size="lg" fw={300}>
                  =
                </Text>
                {loadingRate ? (
                  <Skeleton height={24} width={50} radius="sm" />
                ) : buzzPrice != null ? (
                  <Text fw={800} size="xl" c="green" style={{ lineHeight: 1 }}>
                    {fiatSymbol}
                    {buzzPrice < 10
                      ? buzzPrice.toFixed(2)
                      : numberWithCommas(Math.round(buzzPrice))}
                  </Text>
                ) : (
                  <Text fw={800} size="xl" c="dimmed" style={{ lineHeight: 1 }}>
                    —
                  </Text>
                )}
                <FiatMenu selectedFiat={selectedFiat} onFiatChange={handleFiatChange} size="sm" fw={500} />
              </Group>
            </Stack>

            <Divider className="opacity-15 dark:opacity-15" />

            {/* Conversion flow visual */}
            <Stack gap={6}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.08em' }}>
                How it works
              </Text>
              <Group gap={4} align="center" wrap="nowrap">
                <ThemeIcon size="sm" variant="light" color="orange" radius="xl">
                  <IconCurrencyBitcoin size={12} />
                </ThemeIcon>
                <Text size="xs" c="dimmed" fw={500}>
                  Crypto
                </Text>
                <IconArrowRight size={12} className="text-gray-400 dark:text-gray-600 shrink-0" />
                <ThemeIcon size="sm" variant="light" color="blue" radius="xl">
                  <IconCoins size={12} />
                </ThemeIcon>
                <Text size="xs" c="dimmed" fw={500}>
                  Converted
                </Text>
                <IconArrowRight size={12} className="text-gray-400 dark:text-gray-600 shrink-0" />
                <ThemeIcon size="sm" variant="light" color="yellow" radius="xl">
                  <IconBolt size={12} />
                </ThemeIcon>
                <Text size="xs" c="yellow.4" fw={600}>
                  Buzz
                </Text>
              </Group>
            </Stack>

            <Divider className="opacity-15 dark:opacity-15" />

            {/* Key facts */}
            <Stack gap={8}>
              <FactRow text="Buzz credited upon receipt" />
              <FactRow text="Most transactions complete in one minute" />
              <FactRow text="Each address is permanent — reuse it anytime" />
              <FactRow text="Send any amount above the minimum" />
              <FactRow text="Works from any wallet or exchange" />
            </Stack>
          </Stack>
        </div>

        {/* ── Left action panel ── */}
        <Stack gap="lg" p="lg">
          {error && (
            <Text size="sm" c="red.4">
              {error.message ?? 'Failed to load address'}
            </Text>
          )}

          {/* Currency selector — always visible at top */}
          <Stack gap={4}>
            <Text size="xs" c="dimmed" fw={600} tt="uppercase" style={{ letterSpacing: '0.06em' }}>
              Select currency
            </Text>
            <CurrencyBadges state={currencyState} />
          </Stack>

          {isEmpty && !loading ? (
            <Stack align="center" gap="md" py="xl">
              <ThemeIcon size={56} variant="light" color="blue" radius="xl">
                <IconWallet size={28} />
              </ThemeIcon>
              <Stack gap={4} align="center">
                <Text fw={600}>Generate deposit address</Text>
                <Text size="xs" c="dimmed" ta="center">
                  We&apos;ll create a wallet address for your account
                </Text>
              </Stack>
              <Button onClick={onRetry} loading={loading} leftSection={<IconWallet size={16} />}>
                Generate address
              </Button>
            </Stack>
          ) : (
            <>
              {/* QR code with chaser border */}
              <Group justify="center" className="overflow-visible">
                {isEmpty && loading ? (
                  <Skeleton height={170} width={170} radius="xl" />
                ) : (
                  <QRChaser address={depositAddress} />
                )}
              </Group>

              {/* Address + copy */}
              <Stack gap={6}>
                <Group gap={6} align="center">
                  <Text size="xs" c="dimmed" fw={600} tt="uppercase" style={{ letterSpacing: '0.06em' }}>
                    Your deposit address
                  </Text>
                  <Badge size="xs" variant="light" color="blue" radius="sm">
                    {chainLabel}
                  </Badge>
                </Group>
                {isEmpty && loading ? (
                  <Skeleton height={38} radius="md" />
                ) : (
                  <Group
                    gap={8}
                    wrap="nowrap"
                    p="xs"
                    className="rounded-md border border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-white/[0.04]"
                  >
                    <Text
                      size="xs"
                      ff="monospace"
                      className="break-all flex-1 leading-relaxed text-gray-700 dark:text-gray-300"
                    >
                      {depositAddress}
                    </Text>
                    <Tooltip
                      label={clipboard.copied ? `Copied: ${chainLabel} address` : 'Copy address'}
                      withArrow
                    >
                      <ActionIcon
                        variant="subtle"
                        color={clipboard.copied ? 'green' : 'gray'}
                        onClick={() => {
                          clipboard.copy(depositAddress);
                          setCopiedChain(chain);
                        }}
                        className="shrink-0"
                        aria-label={clipboard.copied ? 'Address copied' : 'Copy deposit address'}
                      >
                        {clipboard.copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                )}
                {chainChangedAfterCopy && (
                  <Group gap={4} wrap="nowrap">
                    <IconAlertTriangle size={14} className="text-yellow-500 shrink-0" />
                    <Text size="xs" c="yellow">
                      Address changed — please re-copy
                    </Text>
                  </Group>
                )}
                {/* Minimum deposit — below address */}
                <MinDepositInfo state={currencyState} />
                <Group gap="xs" wrap="nowrap" align="flex-start">
                  <IconAlertTriangle size={14} className="text-yellow-500" style={{ flexShrink: 0, marginTop: 2 }} />
                  <Text size="xs" c="dimmed">
                    Deposits below the minimum will be lost
                  </Text>
                </Group>
              </Stack>
            </>
          )}
        </Stack>
      </div>
    </Paper>
  );
}

function QRChaser({ address }: { address: string }) {
  return (
    <div className="rounded-xl shadow-[0_4px_6px_-1px_rgba(0,0,0,0.3)] dark:shadow-[0_10px_15px_-3px_rgba(0,0,0,0.8)]">
      <div className="relative rounded-xl p-0.5 overflow-hidden">
        {/* Spinning conic gradient — chaser effect */}
        <div className="absolute -inset-1/2 animate-border-chase pointer-events-none bg-[conic-gradient(from_0deg,transparent_0%,transparent_60%,rgba(0,0,0,0.15)_75%,rgba(0,0,0,0.25)_80%,rgba(0,0,0,0.15)_85%,transparent_100%)] dark:bg-[conic-gradient(from_0deg,transparent_0%,transparent_60%,rgba(255,255,255,0.5)_75%,rgba(255,255,255,0.8)_80%,rgba(255,255,255,0.5)_85%,transparent_100%)]" />
        {/* Static faint border */}
        <div className="absolute inset-0 rounded-xl border-2 border-black/5 dark:border-white/10 pointer-events-none z-[1]" />
        <div className="relative z-[1] inline-flex rounded-lg bg-white p-2.5">
          <QRCodeSVG value={address} size={150} />
        </div>
      </div>
    </div>
  );
}

function FactRow({ text, highlight }: { text: string; highlight?: boolean }) {
  return (
    <Group gap={6} align="flex-start" wrap="nowrap">
      <div
        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
          highlight ? 'bg-yellow-400' : 'bg-gray-400 dark:bg-gray-600'
        }`}
      />
      <Text size="xs" c={highlight ? 'yellow.4' : 'dimmed'} fw={highlight ? 600 : undefined}>
        {text}
      </Text>
    </Group>
  );
}
