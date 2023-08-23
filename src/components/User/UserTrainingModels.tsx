import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Center,
  createStyles,
  Group,
  LoadingOverlay,
  Modal,
  Pagination,
  ScrollArea,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { TrainingStatus } from '@prisma/client';
import { IconAlertCircle, IconCircleCheck, IconExternalLink, IconTrash } from '@tabler/icons-react';
import Link from 'next/link';
import React, { useState } from 'react';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';

import { NoContent } from '~/components/NoContent/NoContent';
import {
  createModelFileDownloadUrl,
  getModelTrainingWizardUrl,
} from '~/server/common/model-helpers';
import { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { formatDate } from '~/utils/date-helpers';
import { formatKBytes } from '~/utils/number-helpers';
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

type TrainingFileData = {
  type: string;
  metadata: FileMetadata;
  url: string;
  sizeKB: number;
};

type ModalData = {
  id?: number;
  file?: TrainingFileData;
};

export default function UserTrainingModels() {
  const { classes, cx } = useStyles();
  const queryUtils = trpc.useContext();

  const [page, setPage] = useState(1);
  const [scrolled, setScrolled] = useState(false);
  const [opened, { open, close }] = useDisclosure(false);
  const [modalData, setModalData] = useState<ModalData>({});

  const { data, isLoading } = trpc.model.getMyTrainingModels.useQuery({ page, limit: 10 });
  const { items, ...pagination } = data || {
    items: [],
    totalItems: 0,
    currentPage: 1,
    pageSize: 1,
    totalPages: 1,
  };

  const deleteMutation = trpc.model.delete.useMutation({
    onSuccess: async () => {
      await queryUtils.model.getMyTrainingModels.invalidate();
    },
  });

  // TODO [bw]: probably need to do something if attempting to delete while running
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

  const hasTraining = items.length > 0;

  const trainingStatusColors = {
    [TrainingStatus.Pending]: 'yellow',
    [TrainingStatus.Submitted]: 'blue',
    [TrainingStatus.Processing]: 'teal',
    [TrainingStatus.InReview]: 'green',
    [TrainingStatus.Approved]: 'green',
    [TrainingStatus.Failed]: 'red',
  };

  console.log(items);

  return (
    <Stack>
      <ScrollArea style={{ height: 400 }} onScrollPositionChange={({ y }) => setScrolled(y !== 0)}>
        <Table verticalSpacing="md" fontSize="md" striped={hasTraining}>
          <thead className={cx(classes.header, { [classes.scrolled]: scrolled })}>
            <tr>
              <th>Name</th>
              <th>Actions</th>
              <th>Type</th>
              <th>Training Status</th>
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
            {hasTraining ? (
              items.map((model) => {
                const thisModelVersion = model.modelVersions[0];
                // TODO why do I have to do this?
                const thisTrainingDetails = thisModelVersion.trainingDetails as
                  | TrainingDetailsObj
                  | undefined;
                const thisFile = thisModelVersion.files[0];

                const hasVersion = model._count.modelVersions > 0;
                const hasFiles = !!thisFile;
                const hasTrainingParams = !!thisTrainingDetails?.params;

                return (
                  <tr key={model.id}>
                    <td>
                      <Link href={getModelTrainingWizardUrl(model)} passHref>
                        <Anchor target="_blank" lineClamp={2}>
                          {model.name} <IconExternalLink size={16} stroke={1.5} />
                        </Anchor>
                      </Link>
                    </td>
                    <td>
                      <>
                        <Modal
                          opened={opened}
                          title="Training Details"
                          overflow="inside"
                          onClose={close}
                          size="lg"
                          centered
                        >
                          <DescriptionTable
                            labelWidth="150px"
                            items={[
                              { label: 'Training Start', value: 'Unknown' }, // TODO [bw] check this later
                              {
                                label: 'Images',
                                value: modalData.file?.metadata?.numImages || 0,
                              },
                              {
                                label: 'Captions',
                                value: modalData.file?.metadata?.numCaptions || 0,
                              },
                              {
                                label: 'Dataset',
                                value: modalData.file?.url ? (
                                  // TODO [bw] wtf is happening when i click this? a subscribe button?
                                  <DownloadButton
                                    component="a"
                                    href={createModelFileDownloadUrl({
                                      versionId: modalData.id as number,
                                      type: 'Training Data',
                                    })}
                                    sx={{ flex: 1 }}
                                  >
                                    <Text align="center">
                                      {`Download (${formatKBytes(modalData.file?.sizeKB)})`}
                                    </Text>
                                  </DownloadButton>
                                ) : (
                                  'None'
                                ),
                              },
                            ]}
                          />
                        </Modal>
                        <Button
                          variant="default"
                          onClick={() => {
                            setModalData({
                              id: thisModelVersion.id,
                              file: thisFile as TrainingFileData,
                            });
                            open();
                          }}
                        >
                          View Details
                        </Button>
                      </>
                    </td>
                    <td>
                      <Badge>{splitUppercase(thisTrainingDetails?.type || 'N/A')}</Badge>
                    </td>
                    <td>
                      <Badge
                        color={
                          thisModelVersion.trainingStatus
                            ? trainingStatusColors[thisModelVersion.trainingStatus] || 'gray'
                            : 'gray'
                        }
                      >
                        {splitUppercase(
                          thisModelVersion.trainingStatus === TrainingStatus.InReview
                            ? 'Ready'
                            : thisModelVersion.trainingStatus || 'N/A'
                        )}
                      </Badge>
                    </td>
                    <td>{formatDate(model.createdAt)}</td>
                    <td>{model.updatedAt ? formatDate(model.updatedAt) : 'N/A'}</td>
                    <td>
                      <Group>
                        {!hasVersion || !hasFiles || !hasTrainingParams ? (
                          <IconAlertCircle size={16} color="orange" />
                        ) : (
                          <IconCircleCheck size={16} color="green" />
                        )}
                        <Stack spacing={4}>
                          {/* technically this step 1 alert should never happen */}
                          {!hasVersion && <Text inherit>Needs basic model data (Step 1)</Text>}
                          {!hasFiles && <Text inherit>Needs training files (Step 2)</Text>}
                          {!hasTrainingParams && (
                            <Text inherit>Needs training parameters (Step 3)</Text>
                          )}
                          {/* TODO [bw] we should probably include the model related fields here after training is done */}
                          {hasVersion && hasFiles && hasTrainingParams && (
                            <Text inherit>All good!</Text>
                          )}
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
                    <NoContent message="You have no training models" />
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
