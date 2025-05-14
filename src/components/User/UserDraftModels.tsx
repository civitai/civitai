import {
  ActionIcon,
  Anchor,
  Badge,
  Center,
  Divider,
  Group,
  LoadingOverlay,
  Pagination,
  ScrollArea,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconAlertCircle, IconExternalLink, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';

import { NoContent } from '~/components/NoContent/NoContent';
import { getModelWizardUrl } from '~/server/common/model-helpers';
import { formatDate } from '~/utils/date-helpers';
import { splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import styles from './UserModelsTable.module.scss';
import clsx from 'clsx';

export function UserDraftModels() {
  const queryUtils = trpc.useUtils();

  const [page, setPage] = useState(1);
  const [scrolled, setScrolled] = useState(false);

  const { data, isLoading } = trpc.model.getMyDraftModels.useQuery({ page, limit: 10 });
  const { items, ...pagination } = data || {
    items: [],
    totalItems: 0,
    currentPage: 1,
    pageSize: 1,
    totalPages: 1,
  };

  const deleteMutation = trpc.model.delete.useMutation({
    onSuccess: async () => {
      await queryUtils.model.getMyDraftModels.invalidate();
    },
  });
  const handleDeleteModel = (model: (typeof items)[number]) => {
    openConfirmModal({
      title: 'Delete model',
      children:
        'Are you sure you want to delete this model? This action is destructive and you will have to contact support to restore your data.',
      centered: true,
      labels: { confirm: 'Delete Model', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deleteMutation.mutate({ id: model.id });
      },
    });
  };

  const hasDrafts = items.length > 0;

  return (
    <Stack>
      <ScrollArea
        // TODO [bw] this 600px here should be autocalced via a css var, to capture the top nav, user info section, and bottom bar
        style={{ height: 'max(400px, calc(100vh - 600px))' }}
        onScrollPositionChange={({ y }) => setScrolled(y !== 0)}
      >
        <Table verticalSpacing="md" className="text-base" striped={hasDrafts}>
          <Table.Thead className={clsx(styles.header, { [styles.scrolled]: scrolled })}>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th>Last Updated</Table.Th>
              <Table.Th>Missing Info</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {isLoading && (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <LoadingOverlay visible />
                </Table.Td>
              </Table.Tr>
            )}
            {hasDrafts ? (
              items.map((model) => {
                const hasVersion = model._count.modelVersions > 0;
                const hasFiles = model.modelVersions.some((version) => version._count.files > 0);
                const hasPosts = model.modelVersions.some((version) => version._count.posts > 0);

                return (
                  <Table.Tr key={model.id}>
                    <Table.Td>
                      <Stack gap={0}>
                        <Text lineClamp={2}> {model.name}</Text>
                        <Divider my={4} />
                        <Link legacyBehavior href={getModelWizardUrl(model)} passHref>
                          <Anchor target="_blank" lineClamp={2}>
                            <Group gap="xs" wrap="nowrap">
                              <Text size="xs">Continue Wizard</Text>{' '}
                              <IconExternalLink size={16} stroke={1.5} />
                            </Group>
                          </Anchor>
                        </Link>
                        <Link legacyBehavior href={`/models/${model.id}`} passHref>
                          <Anchor target="_blank" lineClamp={2}>
                            <Group gap="xs" wrap="nowrap">
                              <Text size="xs">Go to model page</Text>
                              <IconExternalLink size={16} stroke={1.5} />
                            </Group>
                          </Anchor>
                        </Link>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Badge>{splitUppercase(model.type)}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge color="yellow">{splitUppercase(model.status)}</Badge>
                    </Table.Td>
                    <Table.Td>{formatDate(model.createdAt)}</Table.Td>
                    <Table.Td>{model.updatedAt ? formatDate(model.updatedAt) : 'N/A'}</Table.Td>
                    <Table.Td>
                      <Group>
                        {(!hasVersion || !hasFiles || !hasPosts) && (
                          <IconAlertCircle size={16} color="orange" />
                        )}
                        <Stack gap={4}>
                          {!hasVersion && <Text inherit>Needs model version</Text>}
                          {!hasFiles && <Text inherit>Needs model files</Text>}
                          {!hasPosts && <Text inherit>Needs model post</Text>}
                        </Stack>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Group justify="flex-end" pr="xs">
                        <ActionIcon
                          color="red"
                          variant="subtle"
                          size="sm"
                          onClick={() => handleDeleteModel(model)}
                        >
                          <IconTrash />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })
            ) : (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <Center py="md">
                    <NoContent message="You have no draft models" />
                  </Center>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {pagination.totalPages > 1 && (
        <Group justify="space-between">
          <Text>Total {pagination.totalItems} items</Text>
          <Pagination value={page} onChange={setPage} total={pagination.totalPages} />
        </Group>
      )}
    </Stack>
  );
}
