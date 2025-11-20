import { Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import { IconPencil, IconTrash } from '@tabler/icons-react';
import { Page } from '~/components/AppLayout/Page';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { trpc } from '~/utils/trpc';
import { GiftNoticeEditModal } from '~/components/GiftNotice/GiftNoticeEditModal';
import type { UpsertGiftNoticeInput } from '~/server/schema/redeemableCode.schema';
import { numberWithCommas } from '~/utils/number-helpers';
import { formatDate } from '~/utils/date-helpers';

export function CodeGiftsPage() {
  const queryUtils = trpc.useUtils();

  const { data, isLoading } = trpc.redeemableCode.getAllGiftNotices.useQuery();
  const deleteMutation = trpc.redeemableCode.deleteGiftNotice.useMutation({
    onSuccess: () => {
      queryUtils.redeemableCode.getAllGiftNotices.invalidate();
    },
  });

  function openEdit(notice?: {
    id: string;
    startDate: string;
    endDate: string;
    minValue: number;
    maxValue: number | null;
    title: string;
    message: string;
    linkUrl: string;
    linkText: string;
  }) {
    // Convert string dates to Date objects for the form
    const noticeForEdit = notice
      ? {
          ...notice,
          startDate: new Date(notice.startDate),
          endDate: new Date(notice.endDate),
        }
      : undefined;

    dialogStore.trigger({
      component: GiftNoticeEditModal,
      props: { notice: noticeForEdit },
    });
  }

  if (isLoading) return <PageLoader />;

  const now = new Date();

  return (
    <div className="container flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Code Gift Notices</h1>
        <Button onClick={() => openEdit()}>Create New Gift Notice</Button>
      </div>
      <Text size="sm" c="dimmed">
        Manage gift notices that appear when users redeem codes during promotional periods.
      </Text>

      {!data || data.length === 0 ? (
        <Card padding="xl">
          <Text ta="center" c="dimmed">
            No gift notices configured yet. Create one to get started!
          </Text>
        </Card>
      ) : (
        data.map((notice) => {
          const startDate = new Date(notice.startDate);
          const endDate = new Date(notice.endDate);
          const active = startDate <= now && now <= endDate;

          return (
            <Card
              key={notice.id}
              padding="md"
              withBorder
              style={!active ? { opacity: 0.5 } : undefined}
            >
              <Stack gap="sm">
                <Group justify="space-between" wrap="nowrap">
                  <div>
                    <Group gap="xs">
                      <Text size="lg" fw={600}>
                        {notice.title}
                      </Text>
                      {active ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>}
                    </Group>
                    <Text size="sm" c="dimmed">
                      {notice.message}
                    </Text>
                  </div>
                  <Group gap="xs" wrap="nowrap">
                    <LegacyActionIcon onClick={() => openEdit(notice)}>
                      <IconPencil />
                    </LegacyActionIcon>
                    <PopConfirm
                      onConfirm={() => deleteMutation.mutate({ id: notice.id })}
                      withinPortal
                      message="Are you sure you want to delete this gift notice?"
                    >
                      <LegacyActionIcon loading={deleteMutation.isLoading} color="red">
                        <IconTrash />
                      </LegacyActionIcon>
                    </PopConfirm>
                  </Group>
                </Group>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Text size="xs" c="dimmed">
                      Date Range
                    </Text>
                    <Text size="sm">
                      {formatDate(startDate)} - {formatDate(endDate)}
                    </Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">
                      Value Range (Buzz)
                    </Text>
                    <Text size="sm">
                      {numberWithCommas(notice.minValue)} -{' '}
                      {notice.maxValue ? numberWithCommas(notice.maxValue) : 'No Max'}
                    </Text>
                  </div>
                </div>

                {notice.linkUrl && (
                  <div>
                    <Text size="xs" c="dimmed">
                      Call to Action
                    </Text>
                    <Text size="sm">
                      {notice.linkText} → {notice.linkUrl}
                    </Text>
                  </div>
                )}
              </Stack>
            </Card>
          );
        })
      )}
    </div>
  );
}

export default Page(CodeGiftsPage);
