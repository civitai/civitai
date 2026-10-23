import { Anchor, Button, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { AppealDialog } from '~/components/Dialog/Common/AppealDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink } from '~/components/NextLink/NextLink';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { EntityType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

type RemovedImages = RouterOutput['creatorJourney']['getMyRemovedImages'];

/** Fetches only after the member asks: the list can be long. */
export function RemovedImagesList() {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = trpc.creatorJourney.getMyRemovedImages.useQuery(undefined, {
    enabled: open,
  });

  if (!open)
    return (
      <Button variant="default" size="xs" onClick={() => setOpen(true)} className="self-start">
        Show my removed images
      </Button>
    );
  if (isLoading) return <Loader size="sm" />;
  if (isError || !data)
    return (
      <Text size="sm" c="dimmed">
        Your removed images could not be loaded. Try again later.
      </Text>
    );
  return <RemovedImagesView removed={data} />;
}

export function RemovedImagesView({ removed }: { removed: RemovedImages }) {
  if (!removed.items.length)
    return (
      <Text size="sm" c="dimmed">
        No removed images to show.
      </Text>
    );

  return (
    <Stack gap="xs">
      <Text size="sm">
        {removed.truncated
          ? `Your ${numberWithCommas(removed.total)} most recent removed images.`
          : `${numberWithCommas(removed.total)} removed ${
              removed.total === 1 ? 'image' : 'images'
            }.`}{' '}
        Images deleted since their removal show the date and reason only.
      </Text>
      {/* `always`: the default overlay bar only exists while hovered, so a long list looked cut off. */}
      <Table.ScrollContainer minWidth={360} maxHeight={400} scrollAreaProps={{ type: 'always' }}>
        <Table striped verticalSpacing={6} fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Removed</Table.Th>
              <Table.Th>Reason</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {removed.items.map((item, index) => (
              <Table.Tr key={item.imageId ?? `purged-${index}`}>
                <Table.Td className="whitespace-nowrap">{formatDate(item.removedAt)}</Table.Td>
                <Table.Td>{item.reason}</Table.Td>
                <Table.Td>
                  <Group gap="sm" wrap="nowrap" justify="flex-end">
                    {item.imageId && (
                      <Anchor component={NextLink} href={`/images/${item.imageId}`} size="sm">
                        View
                      </Anchor>
                    )}
                    {item.imageId && item.canAppeal && <AppealLink imageId={item.imageId} />}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

function AppealLink({ imageId }: { imageId: number }) {
  return (
    <Anchor
      component="button"
      type="button"
      size="sm"
      onClick={() =>
        dialogStore.trigger({
          component: AppealDialog,
          props: { entityId: imageId, entityType: EntityType.Image },
        })
      }
    >
      Appeal
    </Anchor>
  );
}
