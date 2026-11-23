import { ActionIcon, Button, Group, Select, Stack, Text, Textarea } from '@mantine/core';
import { IconCopy, IconDots, IconFlag, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { openContentDialog } from '~/components/Dialog/Common/ContentDialog';
import { openDialog } from '~/components/Dialog/openDialog';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useMutateMyServices } from '~/components/CreatorShop/Services/creator-service.util';
import { confirmRemoveService } from '~/components/CreatorShop/Services/service-remove-confirm';
import { Menu } from '~/components/MantineOverlays';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { serviceOfferingTakedownReasons } from '~/server/common/moderation-helpers';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

function TakedownForm({ id, title }: { id: number; title: string }) {
  const { onClose } = useDialogContext();
  const utils = trpc.useUtils();
  const [reason, setReason] = useState<string | null>(null);
  const [details, setDetails] = useState('');
  const takedown = trpc.creatorService.takedown.useMutation({
    onSuccess: async () => {
      await utils.creatorService.invalidate();
      onClose();
    },
    onError: (error) => showErrorNotification({ title: 'Could not take the service down', error }),
  });
  const other = reason === 'other';
  return (
    <Stack gap="sm">
      <Text size="sm">&quot;{title}&quot; leaves the shop and the seller is told why.</Text>
      <Select
        label="Reason"
        placeholder="Reason"
        data={Object.entries(serviceOfferingTakedownReasons).map(([value, r]) => ({
          value,
          label: r.optionLabel,
        }))}
        value={reason}
        onChange={setReason}
      />
      <Textarea
        value={details}
        onChange={(e) => setDetails(e.currentTarget.value)}
        maxLength={1000}
        placeholder={
          other
            ? 'What is wrong (sent to the seller)'
            : 'Note for moderators (optional, not sent to the seller)'
        }
      />
      <Text size="xs" c="dimmed">
        {other
          ? 'This text is sent to the seller as the reason.'
          : 'Kept with the takedown for moderators; the seller sees only the reason.'}
      </Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={() => onClose()}>
          Cancel
        </Button>
        <Button
          color="red"
          loading={takedown.isPending}
          disabled={!reason || (other && !details.trim())}
          onClick={() =>
            reason &&
            takedown.mutate({ id, reason: reason as never, details: details.trim() || undefined })
          }
        >
          Yes, take it down
        </Button>
      </Group>
    </Stack>
  );
}

export function ServiceOfferingMenu({
  offering,
  isOwner,
  isModerator,
}: {
  offering: { id: number; title: string };
  isOwner: boolean;
  isModerator: boolean;
}) {
  const { remove } = useMutateMyServices();
  const utils = trpc.useUtils();
  // The card carries only part of the offering; the form copies from the owner's full row.
  const duplicate = async () => {
    try {
      const [{ items }, eligibility] = await Promise.all([
        utils.creatorService.getMine.fetch(),
        utils.creatorService.getSellEligibility.fetch(),
      ]);
      // Checked on click, so the card loads no eligibility until the owner asks to duplicate.
      if (!eligibility.canSell)
        throw new Error('You can list new services once you meet the requirements to sell.');
      const copyOf = items.find((item) => item.id === offering.id);
      if (!copyOf) throw new Error('This service is no longer in your list.');
      openDialog(
        () => import('~/components/CreatorShop/Services/ServiceOfferingFormModal'),
        'ServiceOfferingFormModal',
        { copyOf }
      );
    } catch (error) {
      showErrorNotification({ title: 'Could not duplicate the service', error: error as Error });
    }
  };
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="filled"
          color="dark"
          radius="xl"
          size="md"
          aria-label="Service options"
          className="pointer-events-auto bg-black/60 backdrop-blur-sm"
        >
          <IconDots size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {!isOwner && (
          <LoginRedirect reason="report-content">
            <Menu.Item
              leftSection={<IconFlag size={14} />}
              onClick={() =>
                openReportModal({
                  entityType: ReportEntity.ServiceOffering,
                  entityId: offering.id,
                })
              }
            >
              Report this service
            </Menu.Item>
          </LoginRedirect>
        )}
        {isOwner && (
          <Menu.Item leftSection={<IconCopy size={14} />} onClick={duplicate}>
            Duplicate
          </Menu.Item>
        )}
        {isOwner && (
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() =>
              confirmRemoveService({
                title: offering.title,
                onConfirm: () => remove.mutate({ id: offering.id }),
              })
            }
          >
            Delete
          </Menu.Item>
        )}
        {!isOwner && isModerator && (
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() =>
              openContentDialog({
                title: 'Take down service',
                children: <TakedownForm id={offering.id} title={offering.title} />,
              })
            }
          >
            Delete
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
