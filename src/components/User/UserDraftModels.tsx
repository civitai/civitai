import {
  ActionIcon,
  Anchor,
  Badge,
  Center,
  createStyles,
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
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useState } from 'react';

import { NoContent } from '~/components/NoContent/NoContent';
import { getModelWizardUrl } from '~/server/common/model-helpers';
import { formatDate } from '~/utils/date-helpers';
import { splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  header: {
    position: 'sticky',
    top: 0,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
    transition: 'box-shadow 150ms ease',
    zIndex: 10,

    '&::after': {
      content: '""',
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      borderBottom: `1px solid ${
        theme.colorScheme === 'dark' ? theme.colors.dark[3] : theme.colors.gray[2]
      }`,
    },
  },

  scrolled: {
    boxShadow: theme.shadows.sm,
  },
}));

export function UserDraftModels() {
  const { classes, cx } = useStyles();
  const queryUtils = trpc.useContext();

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
        <Table verticalSpacing="md" fontSize="md" striped={hasDrafts}>
          <thead className={cx(classes.header, { [classes.scrolled]: scrolled })}>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th>Created</th>
              <th>Last Updated</th>
              <th>Missing info</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={7}>
                  <LoadingOverlay visible />
                </td>
              </tr>
            )}
            {hasDrafts ? (
              items.map((model) => {
                const hasVersion = model._count.modelVersions > 0;
                const hasFiles = model.modelVersions.some((version) => version._count.files > 0);
                const hasPosts = model.modelVersions.some((version) => version._count.posts > 0);

                return (
                  <tr key={model.id}>
                    <td>
                      <Stack spacing={0}>
                        <Text lineClamp={2}> {model.name}</Text>
                        <Divider my={4} />
                        <Link legacyBehavior href={getModelWizardUrl(model)} passHref>
                          <Anchor target="_blank" lineClamp={2}>
                            <Group spacing="xs" noWrap>
                              <Text size="xs">Continue Wizard</Text>{' '}
                              <IconExternalLink size={16} stroke={1.5} />
                            </Group>
                          </Anchor>
                        </Link>
                        <Link legacyBehavior href={`/models/${model.id}`} passHref>
                          <Anchor target="_blank" lineClamp={2}>
                            <Group spacing="xs" noWrap>
                              <Text size="xs">Go to model page</Text>
                              <IconExternalLink size={16} stroke={1.5} />
                            </Group>
                          </Anchor>
                        </Link>
                      </Stack>
                    </td>
                    <td>
                      <Badge>{splitUppercase(model.type)}</Badge>
                    </td>
                    <td>
                      <Badge color="yellow">{splitUppercase(model.status)}</Badge>
                    </td>
                    <td>{formatDate(model.createdAt)}</td>
                    <td>{model.updatedAt ? formatDate(model.updatedAt) : 'N/A'}</td>
                    <td>
                      <Group>
                        {(!hasVersion || !hasFiles || !hasPosts) && (
                          <IconAlertCircle size={16} color="orange" />
                        )}
                        <Stack spacing={4}>
                          {!hasVersion && <Text inherit>Needs model version</Text>}
                          {!hasFiles && <Text inherit>Needs model files</Text>}
                          {!hasPosts && <Text inherit>Needs model post</Text>}
                        </Stack>
                      </Group>
                    </td>
                    <td>
                      <Group position="right" pr="xs">
                        <ActionIcon
                          color="red"
                          variant="subtle"
                          size="sm"
                          onClick={() => handleDeleteModel(model)}
                        >
                          <IconTrash />
                        </ActionIcon>
                      </Group>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={7}>
                  <Center py="md">
                    <NoContent message="You have no draft models" />
                  </Center>
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </ScrollArea>
      {pagination.totalPages > 1 && (
        <Group position="apart">
          <Text>Total {pagination.totalItems} items</Text>
          <Pagination page={page} onChange={setPage} total={pagination.totalPages} />
        </Group>
      )}
    </Stack>
  );
}
