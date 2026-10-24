import { Anchor, Badge, Box, Group, LoadingOverlay, Paper, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconExternalLink, IconTrash } from '@tabler/icons-react';
import Link from 'next/link';
import { CardOrSection } from '~/components/Account/SettingsLayout';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import {
  isActiveSubListingStatus,
  type AppSubListingStatus,
} from '~/shared/constants/app-sub-listing.constants';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';

const STATUS: Record<AppSubListingStatus, { label: string; color: string }> = {
  pending: { label: 'In review', color: 'yellow' },
  approved: { label: 'Live', color: 'green' },
  hidden: { label: 'Hidden by a moderator', color: 'red' },
  withdrawn: { label: 'Withdrawn', color: 'gray' },
};

/** Only an item in the store or waiting for review can be withdrawn. */
export const canWithdrawCatalogItem = (status: AppSubListingStatus) =>
  isActiveSubListingStatus(status);

export type CatalogItem = RouterOutput['appListings']['listMyCatalogSubListings']['items'][number];

/** Mark the matching active items withdrawn in the cached list, after a write that did so. */
export function markCatalogItemsWithdrawn(
  utils: ReturnType<typeof trpc.useUtils>,
  match: (item: CatalogItem) => boolean
) {
  utils.appListings.listMyCatalogSubListings.setData(undefined, (old) =>
    old
      ? {
          items: old.items.map((item) =>
            match(item) && canWithdrawCatalogItem(item.status)
              ? { ...item, status: 'withdrawn' as const, pendingEdit: false }
              : item
          ),
        }
      : old
  );
}

/**
 * Items that off-site apps (for example a games site you signed in to with Civitai) listed in the
 * App Store under your name. Each can be withdrawn here; revoking the app's access under
 * Connected apps withdraws them all. Renders nothing when there are none.
 */
export function CatalogItemsCard({ flat }: { flat?: boolean } = {}) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.appListings.listMyCatalogSubListings.useQuery();
  const items = data?.items ?? [];
  const withdrawMutation = trpc.appListings.withdrawMyCatalogSubListing.useMutation({
    onSuccess: (result, { id }) => {
      if (result.withdrawn) {
        // Set rather than refetch: the list is read from a replica that may not have it yet.
        markCatalogItemsWithdrawn(utils, (item) => item.id === id);
        showSuccessNotification({ message: 'Item withdrawn from the App Store' });
      } else {
        // Nothing moved (already withdrawn, or a moderator acted first): show what is there now.
        utils.appListings.listMyCatalogSubListings.invalidate();
      }
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  if (items.length === 0 && !isLoading) return null;

  const handleWithdraw = (id: string, title: string, appName: string) => {
    openConfirmModal({
      title: 'Withdraw store item',
      children: (
        <Text size="sm">
          Withdraw <strong>{title}</strong> from the App Store? If {appName} lists it again, it goes
          back to review before it appears.
        </Text>
      ),
      labels: { confirm: 'Withdraw', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => withdrawMutation.mutate({ id }),
    });
  };

  return (
    <CardOrSection
      flat={flat}
      id="store-items"
      title="Store items listed under your name"
      description="Items that connected apps added to the App Store as yours. Revoking an app's access withdraws its items."
    >
      <Box pos="relative">
        <LoadingOverlay visible={isLoading} />
        <Stack gap="sm">
          {items.map((item) => {
            const status = STATUS[item.status] ?? STATUS.withdrawn;
            return (
              <Paper
                key={item.id}
                withBorder
                p="md"
                radius="md"
                data-testid="catalog-item-row"
                data-catalog-item-id={item.id}
              >
                <Group justify="space-between" align="center" wrap="nowrap">
                  <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                    <Group gap="xs" wrap="nowrap">
                      {item.href ? (
                        <Anchor
                          href={item.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          size="sm"
                          fw={600}
                          lineClamp={1}
                          title={item.title}
                        >
                          {item.title} <IconExternalLink size={12} />
                        </Anchor>
                      ) : (
                        <Text size="sm" fw={600} lineClamp={1} title={item.title}>
                          {item.title}
                        </Text>
                      )}
                      <Badge size="sm" variant="light" color={status.color}>
                        {status.label}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed">
                      in{' '}
                      <Anchor
                        component={Link}
                        href={getListingDetailHref(item.parent.slug)}
                        size="xs"
                      >
                        {item.parent.name}
                      </Anchor>{' '}
                      · updated {formatDate(item.updatedAt)}
                    </Text>
                    {item.status === 'hidden' && item.statusReason && (
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {item.statusReason}
                      </Text>
                    )}
                  </Stack>
                  {canWithdrawCatalogItem(item.status) && (
                    <LegacyActionIcon
                      color="red"
                      variant="subtle"
                      onClick={() => handleWithdraw(item.id, item.title, item.parent.name)}
                      loading={
                        withdrawMutation.isPending && withdrawMutation.variables?.id === item.id
                      }
                      title="Withdraw from the App Store"
                      aria-label={`Withdraw ${item.title}`}
                    >
                      <IconTrash size={16} />
                    </LegacyActionIcon>
                  )}
                </Group>
              </Paper>
            );
          })}
        </Stack>
      </Box>
    </CardOrSection>
  );
}
