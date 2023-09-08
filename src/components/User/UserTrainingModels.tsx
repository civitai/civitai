import {
  Accordion,
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Center,
  createStyles,
  Group,
  HoverCard,
  LoadingOverlay,
  MantineColor,
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
import { constants } from '~/server/common/constants';
import {
  createModelFileDownloadUrl,
  getModelTrainingWizardUrl,
} from '~/server/common/model-helpers';
import { TrainingDetailsObj, TrainingDetailsParams } from '~/server/schema/model-version.schema';
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
  params?: TrainingDetailsParams;
  eta?: string;
};

const trainingStatusFields: Record<TrainingStatus, { color: MantineColor; description: string }> = {
  [TrainingStatus.Pending]: {
    color: 'yellow',
    description:
      'The model has not yet been submitted for training. Important info, like a dataset, may still need to be uploaded.',
  },
  [TrainingStatus.Submitted]: {
    color: 'blue',
    description:
      'A request to train has been submitted, and will soon be actively processing. You will be emailed when it is complete.',
  },
  [TrainingStatus.Processing]: {
    color: 'teal',
    description:
      'The training is actively processing. In other words: the model is baking. You will be emailed when it is complete.',
  },
  [TrainingStatus.InReview]: {
    color: 'green',
    description:
      'Training is completed, and your resulting model files are ready to be reviewed and published.',
  },
  [TrainingStatus.Approved]: {
    color: 'green',
    description: 'The training is complete AND the results were published to Civitai.',
  },
  [TrainingStatus.Failed]: {
    color: 'red',
    description:
      'Something went wrong with the training request. Recreate the training job if you see this error (or contact us for help).',
  },
};

const minsWait = 5 * 60 * 1000;
const minsPerEpoch = 1 * 60 * 1000;
const minsPerEpochSDXL = 5 * 60 * 1000;

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
      // TODO update instead of invalidate
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

  return (
    <Stack>
      <ScrollArea
        // TODO [bw] this 600px here should be autocalced via a css var, to capture the top nav, user info section, and bottom bar
        style={{ height: 'max(400px, calc(100vh - 600px))' }}
        onScrollPositionChange={({ y }) => setScrolled(y !== 0)}
      >
        <Table verticalSpacing="md" fontSize="md" striped={hasTraining}>
          <thead className={cx(classes.header, { [classes.scrolled]: scrolled })}>
            <tr>
              <th>Name</th>
              <th>Actions</th>
              <th>Type</th>
              <th>Training Status</th>
              <th>Created</th>
              <th>ETA</th>
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
                if (!model.modelVersions.length) return null;
                const thisModelVersion = model.modelVersions[0];
                const isProcessing =
                  thisModelVersion.trainingStatus === TrainingStatus.Submitted ||
                  thisModelVersion.trainingStatus === TrainingStatus.Processing;

                const thisTrainingDetails = thisModelVersion.trainingDetails as
                  | TrainingDetailsObj
                  | undefined;
                const thisFile = thisModelVersion.files[0];
                const thisFileMetadata = thisFile?.metadata as FileMetadata | null;

                const hasFiles = !!thisFile;
                const hasTrainingParams = !!thisTrainingDetails?.params;

                const startTime = thisFileMetadata?.trainingResults?.history
                  ?.filter(
                    (h) =>
                      h.status === TrainingStatus.Submitted ||
                      h.status === TrainingStatus.Processing
                  )
                  .slice(-1)?.[0]?.time;
                const numEpochs = thisTrainingDetails?.params?.maxTrainEpochs;
                const baseModel = thisTrainingDetails?.baseModel;
                // nb: so yeah...this estimate can be better.
                const eta =
                  !!startTime && !!numEpochs
                    ? new Date(
                        new Date(startTime).getTime() +
                          minsWait +
                          numEpochs * (baseModel === 'sdxl' ? minsPerEpochSDXL : minsPerEpoch)
                      )
                    : undefined;
                const etaStr = isProcessing
                  ? !!eta
                    ? formatDate(eta, 'MMM D, YYYY hh:mm:ss A')
                    : 'Unknown'
                  : '-';

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
                              {
                                label: 'Training Start',
                                value: modalData.file?.metadata?.trainingResults?.start_time
                                  ? formatDate(
                                      modalData.file.metadata.trainingResults
                                        .start_time as unknown as Date,
                                      'MMM D, YYYY hh:mm:ss A'
                                    )
                                  : 'Unknown',
                              },
                              {
                                label: 'ETA',
                                value: modalData.eta,
                              },
                              {
                                label: 'Training Attempts',
                                value: `${Math.min(
                                  constants.maxTrainingRetries + 1,
                                  (modalData.file?.metadata?.trainingResults?.attempts || 0) + 1
                                )} / ${constants.maxTrainingRetries + 1}`,
                              },
                              {
                                label: 'History',
                                value: (
                                  <Stack spacing={5}>
                                    {modalData.file?.metadata?.trainingResults?.history
                                      ? (
                                          modalData.file?.metadata?.trainingResults?.history || []
                                        ).map((h) => (
                                          <Group key={h.time}>
                                            <Text inline>
                                              {formatDate(
                                                h.time as unknown as Date,
                                                'MM/DD/YYYY hh:mm:ss A'
                                              )}
                                            </Text>
                                            <Text inline>
                                              <Badge
                                                color={
                                                  trainingStatusFields[h.status]?.color ?? 'gray'
                                                }
                                              >
                                                {splitUppercase(
                                                  h.status === TrainingStatus.InReview
                                                    ? 'Ready'
                                                    : h.status
                                                )}
                                              </Badge>
                                            </Text>
                                          </Group>
                                        ))
                                      : 'No history found'}
                                  </Stack>
                                ),
                              },
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
                                  <DownloadButton
                                    component="a"
                                    canDownload
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
                              {
                                label: 'Training Params',
                                value: modalData.params ? (
                                  <Accordion
                                    styles={(theme) => ({
                                      content: {
                                        padding: theme.spacing.xs,
                                      },
                                      item: {
                                        // overflow: 'hidden',
                                        border: 'none',
                                        background: 'transparent',
                                      },
                                      control: {
                                        padding: theme.spacing.xs,
                                      },
                                    })}
                                  >
                                    <Accordion.Item value="params">
                                      <Accordion.Control>Expand</Accordion.Control>
                                      <Accordion.Panel>
                                        <pre style={{ margin: 0 }}>
                                          {JSON.stringify(modalData.params, null, 2)}
                                        </pre>
                                      </Accordion.Panel>
                                    </Accordion.Item>
                                  </Accordion>
                                ) : (
                                  'No training params set'
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
                              params: thisTrainingDetails?.params,
                              eta: etaStr,
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
                      {thisModelVersion.trainingStatus ? (
                        <HoverCard shadow="md" width={300} zIndex={100} withArrow>
                          <HoverCard.Target>
                            <Badge
                              color={
                                trainingStatusFields[thisModelVersion.trainingStatus]?.color ??
                                'gray'
                              }
                            >
                              {splitUppercase(
                                thisModelVersion.trainingStatus === TrainingStatus.InReview
                                  ? 'Ready'
                                  : thisModelVersion.trainingStatus
                              )}
                            </Badge>
                          </HoverCard.Target>
                          <HoverCard.Dropdown>
                            <Text>
                              {trainingStatusFields[thisModelVersion.trainingStatus]?.description ??
                                'N/A'}
                            </Text>
                          </HoverCard.Dropdown>
                        </HoverCard>
                      ) : (
                        <Badge color="gray">N/A</Badge>
                      )}
                    </td>
                    <td>
                      <HoverCard openDelay={400} shadow="md" zIndex={100} withArrow>
                        <HoverCard.Target>
                          <Text>{formatDate(model.createdAt)}</Text>
                        </HoverCard.Target>
                        {new Date(model.createdAt).getTime() !==
                          new Date(model.updatedAt).getTime() && (
                          <HoverCard.Dropdown>
                            <Text>Updated: {formatDate(model.updatedAt)}</Text>
                          </HoverCard.Dropdown>
                        )}
                      </HoverCard>
                    </td>
                    <td>{etaStr}</td>
                    <td>
                      <Group>
                        {!hasFiles || !hasTrainingParams ? (
                          <IconAlertCircle size={16} color="orange" />
                        ) : (
                          <IconCircleCheck size={16} color="green" />
                        )}
                        <Stack spacing={4}>
                          {/* technically this step 1 alert should never happen */}
                          {/*{!hasVersion && <Text inherit>Needs basic model data (Step 1)</Text>}*/}
                          {!hasFiles && <Text inherit>Needs training files (Step 2)</Text>}
                          {!hasTrainingParams && (
                            <Text inherit>Needs training parameters (Step 3)</Text>
                          )}
                          {/* TODO [bw] we should probably include the model related fields here after training is done */}
                          {hasFiles && hasTrainingParams && <Text inherit>All good!</Text>}
                        </Stack>
                      </Group>
                    </td>
                    <td>
                      <Group position="right" pr="xs">
                        <ActionIcon
                          color="red"
                          variant="subtle"
                          size="sm"
                          onClick={() => !isProcessing && handleDeleteModel(model)}
                          disabled={isProcessing}
                        >
                          <IconTrash />
                        </ActionIcon>
                      </Group>
                    </td>
                  </tr>
                );
              })
            ) : !isLoading ? (
              <tr>
                <td colSpan={7}>
                  <Center py="md">
                    <NoContent message="You have no training models" />
                  </Center>
                </td>
              </tr>
            ) : (
              <></>
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
