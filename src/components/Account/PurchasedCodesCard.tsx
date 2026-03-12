import { useState } from 'react';
import {
  Text,
  Stack,
  Group,
  Title,
  Box,
  Badge,
  Paper,
  Center,
  CopyButton,
  Button,
  Tooltip,
  Pagination,
  Skeleton,
  UnstyledButton,
} from '@mantine/core';
import buzzClasses from '~/components/Buzz/buzz.module.scss';
import { IconCopy, IconCheck, IconGift, IconTicket } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';

const DEFAULT_PAGE_SIZE = 10;
const COMPACT_PAGE_SIZE = 3;

type PurchasedCode = {
  code: string;
  type: string;
  unitValue: number;
  createdAt: Date;
  expiresAt: Date | null;
  redeemedAt: Date | null;
  priceId: string | null;
  price: { product: { metadata: unknown } } | null;
};

type CodeRowProps = {
  item: PurchasedCode;
  onInvalidate: () => void;
};

function useCodeRowData(item: PurchasedCode) {
  const isRedeemed = !!item.redeemedAt;
  const tier =
    item.type === 'Membership' && item.price?.product?.metadata
      ? (item.price.product.metadata as { tier?: string })?.tier
      : undefined;
  const description =
    item.type === 'Buzz'
      ? `${item.unitValue.toLocaleString()} Buzz`
      : `${item.unitValue}-mo ${tier ? tier.charAt(0).toUpperCase() + tier.slice(1) + ' ' : ''}Membership`;

  return { isRedeemed, tier, description };
}

function useRedeemMutation(onInvalidate: () => void) {
  return trpc.redeemableCode.consume.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Code redeemed successfully!' });
      onInvalidate();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to redeem code',
        error: new Error(error.message),
      });
    },
  });
}

function CopyableCode({ code }: { code: string }) {
  return (
    <CopyButton value={code}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copied!' : 'Click to copy'} position="top">
          <UnstyledButton
            onClick={copy}
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-gray-500 dark:text-gray-400 bg-black/5 hover:bg-black/10 dark:bg-black/20 dark:hover:bg-black/30 transition-colors"
          >
            <span>{code}</span>
            {copied ? (
              <IconCheck size={11} stroke={1.5} className="text-teal-400 shrink-0" />
            ) : (
              <IconCopy size={11} stroke={1.5} className="opacity-50 shrink-0" />
            )}
          </UnstyledButton>
        </Tooltip>
      )}
    </CopyButton>
  );
}

function CodeRow({ item, onInvalidate }: CodeRowProps) {
  const { isRedeemed, description } = useCodeRowData(item);
  const redeemMutation = useRedeemMutation(onInvalidate);
  const accentColor =
    item.type === 'Buzz' ? 'var(--mantine-color-yellow-5)' : 'var(--mantine-color-blue-5)';

  return (
    <Paper
      p="sm"
      radius="sm"
      withBorder
      className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10"
      style={{
        borderLeft: `3px solid ${accentColor}`,
      }}
    >
      <Group justify="space-between" wrap="nowrap" align="center">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Text size="sm" fw={700}>
            {description}
          </Text>
          <div style={{ alignSelf: 'flex-start' }}>
            <CopyableCode code={item.code} />
          </div>
        </Stack>
        <Stack gap={4} align="flex-end" style={{ flexShrink: 0 }}>
          {isRedeemed ? (
            <Badge variant="light" color="green" size="sm">
              Redeemed
            </Badge>
          ) : (
            <Button
              size="compact-xs"
              leftSection={<IconGift size={14} stroke={1.5} />}
              loading={redeemMutation.isLoading}
              onClick={() => redeemMutation.mutate({ code: item.code })}
            >
              Redeem
            </Button>
          )}
          <Text size="xs" c="dimmed">
            {formatDate(item.createdAt)}
          </Text>
        </Stack>
      </Group>
    </Paper>
  );
}

export function PurchasedCodesCard({ compact }: { compact?: boolean } = {}) {
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const pageSize = compact ? COMPACT_PAGE_SIZE : DEFAULT_PAGE_SIZE;

  const { data, isLoading } = trpc.redeemableCode.getMyPurchasedCodes.useQuery();
  const codes = data ?? [];

  const totalPages = Math.ceil(codes.length / pageSize);
  const paginatedCodes = codes.slice((page - 1) * pageSize, page * pageSize);

  return (
    <Paper className={buzzClasses.tileCard} id="purchased-codes" h="100%" p="lg" radius="md">
      <Title order={4}>Purchased Codes</Title>
      <Box mt="md">
        {isLoading ? (
          <Stack gap="xs">
            {Array.from({ length: compact ? COMPACT_PAGE_SIZE : 3 }).map((_, i) => (
              <Paper
                key={i}
                p="sm"
                radius="sm"
                withBorder
                className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10"
                style={{ borderLeft: '3px solid var(--mantine-color-gray-4)' }}
              >
                <Group justify="space-between" wrap="nowrap" align="center">
                  <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                    <Skeleton height={14} width="60%" radius="sm" />
                    <Skeleton height={12} width="40%" radius="sm" />
                  </Stack>
                  <Stack gap={4} align="flex-end" style={{ flexShrink: 0 }}>
                    <Skeleton height={22} width={70} radius="sm" />
                    <Skeleton height={10} width={60} radius="sm" />
                  </Stack>
                </Group>
              </Paper>
            ))}
          </Stack>
        ) : codes.length === 0 ? (
          <Stack align="center" gap={6} py="xl">
            <IconTicket size={32} stroke={1.5} style={{ opacity: 0.3 }} />
            <Text size="sm" fw={500} c="white">
              No codes yet
            </Text>
            <Text size="xs" c="dimmed">
              Redeem a code above to see it here
            </Text>
          </Stack>
        ) : paginatedCodes.length > 0 ? (
          <Stack gap="xs">
            {paginatedCodes.map((item) => (
              <CodeRow
                key={item.code}
                item={item}
                onInvalidate={() => utils.redeemableCode.getMyPurchasedCodes.invalidate()}
              />
            ))}
            {totalPages > 1 && (
              <Center mt="sm">
                <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
              </Center>
            )}
          </Stack>
        ) : null}
      </Box>
    </Paper>
  );
}
