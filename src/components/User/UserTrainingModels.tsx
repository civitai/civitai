import {
  Accordion,
  ActionIcon,
  Badge,
  Button,
  Center,
  createStyles,
  Divider,
  Group,
  HoverCard,
  Loader,
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
import { IconAlertCircle, IconCircleCheck, IconTrash } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useRouter } from 'next/router';
import React, { useCallback, useState } from 'react';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';

import { NoContent } from '~/components/NoContent/NoContent';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { constants } from '~/server/common/constants';
import { SignalMessages } from '~/server/common/enums';
import {
  createModelFileDownloadUrl,
  getModelTrainingWizardUrl,
} from '~/server/common/model-helpers';
import { TrainingDetailsObj, TrainingDetailsParams } from '~/server/schema/model-version.schema';
import { TrainingUpdateSignalSchema } from '~/server/schema/signals.schema';
import { MyTrainingModelGetAll } from '~/types/router';
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

const modelsLimit = 10;

const minsWait = 5 * 60 * 1000;
const minsPerEpoch = 1 * 60 * 1000;
const minsPerEpochSDXL = 5 * 60 * 1000;

const TrainingSignals = () => {
  const queryClient = useQueryClient();

  const onUpdate = useCallback(
    (updated: TrainingUpdateSignalSchema) => {
      const queryKey = getQueryKey(trpc.model.getMyTrainingModels);
      queryClient.setQueriesData(
        { queryKey, exact: false },
        produce((old: MyTrainingModelGetAll | undefined) => {
          const model = old?.items?.find((x) => x.id == updated.modelId);
          const mv = model?.modelVersions[0];
          if (mv) {
            mv.trainingStatus = updated.status;
            const mFile = mv.files[0];
            if (mFile) {
              mFile.metadata = updated.fileMetadata;
            }
          }
        })
      );
    },
    [queryClient]
  );

  useSignalConnection(SignalMessages.TrainingUpdate, onUpdate);

  return null;
};

export default function UserTrainingModels() {
  const { classes, cx } = useStyles();
  const queryUtils = trpc.useContext();
  const router = useRouter();

  const [page, setPage] = useState(1);
  const [scrolled, setScrolled] = useState(false);
  const [opened, { open, close }] = useDisclosure(false);
  const [modalData, setModalData] = useState<ModalData>({});

  const { data, isLoading } = trpc.model.getMyTrainingModels.useQuery({ page, limit: modelsLimit });
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

  const goToModel = (e: React.MouseEvent<HTMLTableRowElement>, href: string) => {
    if (opened) return false;
    // on control click or middle click, open in new tab
    if ((e.ctrlKey && e.button === 0) || e.button === 1) {
      e.preventDefault();
      window.open(href, '_blank');
    } else if (e.button === 0) {
      router.push(href);
    }
  };

  const handleDeleteModel = (
    e: React.MouseEvent<HTMLButtonElement>,
    model: MyTrainingModelGetAll['items'][number]
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;
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
        <Table
          verticalSpacing="md"
          fontSize="md"
          striped={hasTraining}
          highlightOnHover={hasTraining}
        >
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
                const epochsDone = thisFileMetadata?.trainingResults?.epochs?.length || 0;
                // const epochsPct = Math.round((numEpochs ? epochsDone / numEpochs : 0) * 10);
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
                  // nb:
                  // Cannot use <Link> here as it doesn't properly wrap rows, handle middle clicks, etc.
                  // onClick doesn't handle middle clicks
                  // onAuxClick should work, but for some reason doesn't handle middle clicks
                  // onMouseUp is not perfect, but it's the closest thing we've got
                  // which means all click events inside that need to also be mouseUp, so they can be properly de-propagated
                  <tr
                    key={model.id}
                    style={{ cursor: 'pointer' }}
                    onMouseUp={(e) => goToModel(e, getModelTrainingWizardUrl(model))}
                  >
                    <td>{model.name}</td>
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
                          onMouseUp={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (e.button !== 0) return;
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
                            <Group spacing="sm">
                              {/*<Stack>*/}
                              <Badge
                                color={
                                  trainingStatusFields[thisModelVersion.trainingStatus]?.color ??
                                  'gray'
                                }
                              >
                                <Group spacing={6}>
                                  {splitUppercase(
                                    thisModelVersion.trainingStatus === TrainingStatus.InReview
                                      ? 'Ready'
                                      : thisModelVersion.trainingStatus
                                  )}
                                  {(thisModelVersion.trainingStatus === TrainingStatus.Submitted ||
                                    thisModelVersion.trainingStatus ===
                                      TrainingStatus.Processing) && <Loader size={12} />}
                                </Group>
                              </Badge>
                              {thisModelVersion.trainingStatus === TrainingStatus.Processing && (
                                <>
                                  <Divider size="sm" orientation="vertical" />
                                  <Badge
                                    variant="filled"
                                    // color={`gray.${Math.max(Math.min(epochsPct, 9), 0)}`}
                                    color={'gray'}
                                  >
                                    {`Step ${epochsDone}/${numEpochs}`}
                                  </Badge>
                                </>
                              )}
                            </Group>
                            {/*</Stack>*/}
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
                          onMouseUp={(e) => !isProcessing && handleDeleteModel(e, model)}
                          disabled={isProcessing}
                        >
                          <IconTrash />
                        </ActionIcon>
                      </Group>
                    </td>
                  </tr>
                  // </Link>
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
      <TrainingSignals />
    </Stack>
  );
}
