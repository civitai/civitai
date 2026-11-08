import { ActionIcon, Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';
import { DepositNetworkWarning } from '~/components/Buzz/CryptoDeposit/DepositNetworkWarning';

const address = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';

function AddressBlock({
  code,
  ticker,
  network,
}: {
  code: string;
  ticker?: string;
  network?: string;
}) {
  return (
    <Paper withBorder p="lg" radius="md" style={{ maxWidth: 480 }}>
      <Stack gap={6}>
        <Group gap={6}>
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Your deposit address
          </Text>
          <Badge size="xs" variant="light" color="blue" radius="sm">
            Ethereum — Base
          </Badge>
        </Group>
        <DepositNetworkWarning code={code} ticker={ticker} network={network} />
        <Group
          gap={8}
          wrap="nowrap"
          p="xs"
          className="rounded-md border border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-white/[0.04]"
        >
          <Text size="xs" ff="monospace" className="flex-1 break-all">
            {address}
          </Text>
          <ActionIcon variant="subtle" color="gray" aria-label="Copy deposit address">
            <IconCopy size={16} />
          </ActionIcon>
        </Group>
      </Stack>
    </Paper>
  );
}

export const UsdcBase = () => <AddressBlock code="USDCBASE" />;
export const UsdtTron = () => <AddressBlock code="USDTTRC20" />;
export const UnknownCode = () => <AddressBlock code="foocoinx" network="xlayer" />;
