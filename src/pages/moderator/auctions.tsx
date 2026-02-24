import {
  Badge,
  Button,
  Group,
  Modal,
  Pagination,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { useState } from 'react';
import { formatDate } from '~/utils/date-helpers';
import * as z from 'zod';
import { Page } from '~/components/AppLayout/Page';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Form, InputNumber, InputSwitch, InputTextArea, useForm } from '~/libs/form';
import { updateAuctionBaseInput } from '~/server/schema/auction.schema';
import type { GetAuctionBasesReturn } from '~/server/services/auction.service';
import { trpc } from '~/utils/trpc';

type AuctionBaseItem = GetAuctionBasesReturn['items'][number];

const editSchema = updateAuctionBaseInput.omit({ id: true });

function EditAuctionBaseModal({
  item,
  opened,
  onClose,
}: {
  item: AuctionBaseItem;
  opened: boolean;
  onClose: () => void;
}) {
  const queryUtils = trpc.useUtils();
  const form = useForm({
    schema: editSchema,
    defaultValues: {
      quantity: item.quantity,
      minPrice: item.minPrice,
      active: item.active,
      runForDays: item.runForDays,
      validForDays: item.validForDays,
      description: item.description ?? '',
    },
  });

  const updateMutation = trpc.auction.modUpdateAuctionBase.useMutation({
    onSuccess: () => {
      queryUtils.auction.modGetAuctionBases.invalidate();
      onClose();
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title={`Edit: ${item.name}`} size="md">
      <Form form={form} onSubmit={(data) => updateMutation.mutate({ ...data, id: item.id })}>
        <Stack>
          <InputNumber name="quantity" label="Slots (quantity)" min={1} />
          <InputNumber name="minPrice" label="Min Price (Buzz)" min={1} />
          <InputSwitch name="active" label="Active" />
          <InputNumber name="runForDays" label="Run For Days" min={1} />
          <InputNumber name="validForDays" label="Valid For Days" min={1} />
          <InputTextArea name="description" label="Description" autosize minRows={2} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={updateMutation.isLoading}>
              Save Changes
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}

function AuctionsPage() {
  const [page, setPage] = useState(1);
  const [editItem, setEditItem] = useState<AuctionBaseItem | null>(null);

  const { data, isLoading } = trpc.auction.modGetAuctionBases.useQuery({ page, limit: 20 });

  if (isLoading) return <PageLoader />;

  return (
    <div className="container flex flex-col gap-4">
      <Title order={1}>Auction Management</Title>
      <Text c="dimmed">Manage base auction configurations. Changes here only take effect on newly created auctions — the current running auction is not affected.</Text>

      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Ecosystem</Table.Th>
            <Table.Th>Slots</Table.Th>
            <Table.Th>Min Price</Table.Th>
            <Table.Th>Active</Table.Th>
            <Table.Th>Run Days</Table.Th>
            <Table.Th>Valid Days</Table.Th>
            <Table.Th>Current Auction</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data?.items.map((item) => (
            <Table.Tr key={item.id}>
              <Table.Td>{item.name}</Table.Td>
              <Table.Td>{item.type}</Table.Td>
              <Table.Td>{item.ecosystem ?? '-'}</Table.Td>
              <Table.Td>
                {item.quantity}
                {item.currentAuction && item.currentAuction.quantity !== item.quantity && (
                  <Text span c="dimmed" size="xs"> (live: {item.currentAuction.quantity})</Text>
                )}
              </Table.Td>
              <Table.Td>
                {item.minPrice}
                {item.currentAuction && item.currentAuction.minPrice !== item.minPrice && (
                  <Text span c="dimmed" size="xs"> (live: {item.currentAuction.minPrice})</Text>
                )}
              </Table.Td>
              <Table.Td>
                <Badge color={item.active ? 'green' : 'red'}>
                  {item.active ? 'Active' : 'Inactive'}
                </Badge>
              </Table.Td>
              <Table.Td>{item.runForDays}</Table.Td>
              <Table.Td>{item.validForDays}</Table.Td>
              <Table.Td>
                {item.currentAuction ? (
                  <Stack gap={2}>
                    <Text size="sm">{item.currentAuction.bidCount} bids</Text>
                    <Text size="xs" c="dimmed">
                      {formatDate(item.currentAuction.startAt, 'MMM D', true)} &rarr; {formatDate(item.currentAuction.endAt, 'MMM D', true)}
                    </Text>
                  </Stack>
                ) : (
                  <Text size="sm" c="dimmed">None</Text>
                )}
              </Table.Td>
              <Table.Td>
                <LegacyActionIcon onClick={() => setEditItem(item)}>
                  <IconPencil size={16} />
                </LegacyActionIcon>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      {data && data.totalPages > 1 && (
        <div className="flex justify-end">
          <Pagination value={page} total={data.totalPages} onChange={setPage} />
        </div>
      )}

      {editItem && (
        <EditAuctionBaseModal
          item={editItem}
          opened={!!editItem}
          onClose={() => setEditItem(null)}
        />
      )}
    </div>
  );
}

export default Page(AuctionsPage, { features: (f) => f.auctionsMod });
