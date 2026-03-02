import { useState } from 'react';
import {
  Text,
  Card,
  Stack,
  Group,
  Title,
  Box,
  LoadingOverlay,
  Code,
  Badge,
  Paper,
  Center,
  CopyButton,
  ActionIcon,
  Button,
  Tooltip,
  Pagination,
} from '@mantine/core';
import { IconCopy, IconCheck, IconGift } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';

const PAGE_SIZE = 10;

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

function PurchasedCodeRow({
  item,
  onInvalidate,
}: {
  item: PurchasedCode;
  onInvalidate: () => void;
}) {
  const isRedeemed = !!item.redeemedAt;

  const redeemMutation = trpc.redeemableCode.consume.useMutation({
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

  const tier =
    item.type === 'Membership' && item.price?.product?.metadata
      ? (item.price.product.metadata as { tier?: string })?.tier
      : undefined;

  const description =
    item.type === 'Buzz'
      ? `${item.unitValue.toLocaleString()} Buzz`
      : `${item.unitValue}-mo ${tier ? tier.charAt(0).toUpperCase() + tier.slice(1) + ' ' : ''}Membership`;

  return (
    <Group justify="space-between" wrap="nowrap" gap="xs" py={4}>
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <Badge
          variant="light"
          color={item.type === 'Buzz' ? 'yellow' : 'blue'}
          size="sm"
          style={{ flexShrink: 0 }}
        >
          {description}
        </Badge>
        <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
          <Code fz="xs" style={{ whiteSpace: 'nowrap' }}>
            {item.code}
          </Code>
          <CopyButton value={item.code}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy code'}>
                <ActionIcon
                  variant="subtle"
                  color={copied ? 'teal' : 'gray'}
                  onClick={copy}
                  size="xs"
                >
                  {copied ? (
                    <IconCheck size={12} stroke={1.5} />
                  ) : (
                    <IconCopy size={12} stroke={1.5} />
                  )}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
          {formatDate(item.createdAt)}
        </Text>
      </Group>
      <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
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
      </Group>
    </Group>
  );
}

export function PurchasedCodesCard() {
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);

  const { data, isLoading } = trpc.redeemableCode.getMyPurchasedCodes.useQuery();
  const codes = data ?? [];

  if (!isLoading && codes.length === 0) return null;

  const totalPages = Math.ceil(codes.length / PAGE_SIZE);
  const paginatedCodes = codes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <Card withBorder>
      <Stack gap={0}>
        <Title order={2}>Purchased Codes</Title>
        <Text c="dimmed" size="sm">
          Codes associated with your account. Redeem or share them as gifts.
        </Text>
      </Stack>
      <Box mt="md" style={{ position: 'relative', minHeight: 40 }}>
        <LoadingOverlay visible={isLoading} />
        {paginatedCodes.length > 0 && (
          <Stack gap={0}>
            {paginatedCodes.map((item) => (
              <PurchasedCodeRow
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
        )}
      </Box>
    </Card>
  );
}
