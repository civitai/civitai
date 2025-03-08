import {
  Accordion,
  ActionIcon,
  Anchor,
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
import {
  IconAlertCircle,
  IconCheck,
  IconCircleCheck,
  IconExclamationCircle,
  IconExternalLink,
  IconFileDescription,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { TrainStatusMessage } from '~/components/Training/Wizard/TrainWizard';
import {
  createModelFileDownloadUrl,
  getModelTrainingWizardUrl,
} from '~/server/common/model-helpers';
import {
  TrainingDetailsBaseModelList,
  TrainingDetailsObj,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { MyTrainingModelGetAll } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { getAirModelLink, isAir, splitUppercase } from '~/utils/string-helpers';
import { trainingModelInfo } from '~/utils/training';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

// TODO make this an importable var
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
  baseModel?: string;
  params?: TrainingDetailsParams;
};

export const trainingStatusFields: {
  [key in TrainingStatus]: { color: MantineColor; description: string };
} = {
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
  [TrainingStatus.Paused]: {
    color: 'orange',
    description:
      'Your training will resume or terminate within 1 business day. No action is required on your part.',
  },
  [TrainingStatus.Denied]: {
    color: 'red',
    description:
      'We have found an issue with the training dataset that may violate the TOS. This request has been rejected - please contact us with any questions.',
  },
  [TrainingStatus.Processing]: {
    color: 'teal',
    description:
      'The training job is actively processing. In other words: the model is baking. You will be emailed when it is complete.',
  },
  [TrainingStatus.InReview]: {
    color: 'green',
    description:
      'Training is complete, and your resulting model files are ready to be reviewed and published.',
  },
  [TrainingStatus.Approved]: {
    color: 'green',
    description:
      'Training is complete, and you have selected an Epoch. You may click here to continue the publishing setup.',
  },
  [TrainingStatus.Failed]: {
    color: 'red',
    description:
      'Something went wrong with the training request. Recreate the training job if you see this error (or contact us for help).',
  },
};

const modelsLimit = 10;

export default function UserTrainingModels() {
  const { classes, cx } = useStyles();
  const queryUtils = trpc.useUtils();
  const router = useRouter();

  const [page, setPage] = useState(1);
  const [scrolled, setScrolled] = useState(false);
  const [modalData, setModalData] = useState<ModalData>({});
  const [opened, { open, close }] = useDisclosure(false);

  const { data, isLoading } = trpc.model.getMyTrainingModels.useQuery({ page, limit: modelsLimit });
  const { items, ...pagination } = data || {
    items: [],
    totalItems: 0,
    currentPage: 1,
    pageSize: 1,
    totalPages: 1,
  };

  const deleteMutation = trpc.modelVersion.delete.useMutation({
    onSuccess: async () => {
      // TODO update instead of invalidate
      await queryUtils.model.getMyTrainingModels.invalidate();
    },
  });
  const deleteModelMutation = trpc.model.delete.useMutation({
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
      router.push(href).then();
    }
  };

  const handleDelete = (
    e: React.MouseEvent<HTMLButtonElement>,
    modelVersion: MyTrainingModelGetAll['items'][number]
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;

    if (modelVersion.model._count.modelVersions > 1) {
      handleDeleteVersion(modelVersion);
    } else {
      handleDeleteModel(modelVersion);
    }
  };

  const handleDeleteVersion = (modelVersion: MyTrainingModelGetAll['items'][number]) => {
    openConfirmModal({
      title: 'Delete version',
      children:
        'Are you sure you want to delete this version? This action is destructive and cannot be reverted.',
      centered: true,
      labels: { confirm: 'Delete Version', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deleteMutation.mutate({ id: modelVersion.id });
      },
    });
  };

  const handleDeleteModel = (modelVersion: MyTrainingModelGetAll['items'][number]) => {
    openConfirmModal({
      title: 'Delete model',
      children:
        'Are you sure you want to delete this model? This action is destructive and you will have to contact support to restore your data.',
      centered: true,
      labels: { confirm: 'Delete Model', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deleteModelMutation.mutate({ id: modelVersion.model.id });
      },
    });
  };

  const hasTraining = items.length > 0;

  return (
    <Stack>
      <TrainStatusMessage />
      <AlertWithIcon
        icon={<IconExclamationCircle size={16} />}
        iconColor="yellow"
        color="yellow"
        size="sm"
      >
        Due to high load, LoRA Trainings are not always successful - they may fail or get stuck in
        processing. Not to worry though, if your LoRA training fails your Buzz will be refunded
        within 24 hours. If your training has been processing for more than 24 hours it will be auto
        failed and a refund will be issued to you. If your training fails it&apos;s recommended that
        you try again.
      </AlertWithIcon>
      <ScrollArea
        // TODO [bw] this 600px here should be autocalced via a css var, to capture the top nav, user info section, and bottom bar
        style={{ height: 'max(400px, calc(100vh - 600px))' }}
        onScrollPositionChange={({ y }) => setScrolled(y !== 0)}
      >
        {/* TODO [bw] this should probably be transitioned to a filterable/sortable table, like in reports.tsx */}
        <Table
          verticalSpacing="md"
          fontSize="md"
          striped={hasTraining}
          highlightOnHover={hasTraining}
        >
          <thead className={cx(classes.header, { [classes.scrolled]: scrolled })}>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Model</th>
              <th>Training Status</th>
              <th>Created</th>
              <th>Start</th>
              <th>Missing info</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={7}>
                  <LoadingOverlay visible={true} />
                </td>
              </tr>
            )}
            {hasTraining ? (
              items.map((mv) => {
                const isSubmitted = mv.trainingStatus === TrainingStatus.Submitted;
                const isProcessing = mv.trainingStatus === TrainingStatus.Processing;
                const isPaused = mv.trainingStatus === TrainingStatus.Paused;
                const isRunning = isSubmitted || isProcessing;
                const isNotDeletable = isRunning || isPaused;

                const thisTrainingDetails = mv.trainingDetails as TrainingDetailsObj | undefined;
                const thisFile = mv.files[0];
                const thisFileMetadata = thisFile?.metadata as FileMetadata | null;

                const hasFiles = !!thisFile;
                const trainingParams = thisTrainingDetails?.params;
                const hasTrainingParams = !!trainingParams;

                const numEpochs = trainingParams?.maxTrainEpochs;
                const epochsDone =
                  (thisFileMetadata?.trainingResults?.version === 2
                    ? thisFileMetadata?.trainingResults?.epochs?.slice(-1)[0]?.epochNumber
                    : thisFileMetadata?.trainingResults?.epochs?.slice(-1)[0]?.epoch_number) ?? 0;
                // const epochsPct = Math.round((numEpochs ? epochsDone / numEpochs : 0) * 10);

                const startDate = thisFileMetadata?.trainingResults?.submittedAt;
                const startStr = !!startDate
                  ? formatDate(startDate, 'MMM D, YYYY hh:mm:ss A')
                  : '-';

                return (
                  // nb:
                  // Cannot use <Link> here as it doesn't properly wrap rows, handle middle clicks, etc.
                  // onClick doesn't handle middle clicks
                  // onAuxClick should work, but for some reason doesn't handle middle clicks
                  // onMouseUp is not perfect, but it's the closest thing we've got
                  // which means all click events inside that need to also be mouseUp, so they can be properly de-propagated
                  <tr
                    key={mv.id}
                    style={{ cursor: 'pointer' }}
                    onMouseUp={(e) => {
                      goToModel(e, getModelTrainingWizardUrl(mv));
                    }}
                    onMouseDown={(e) => {
                      if (e.button == 1) {
                        e.preventDefault();
                        return false;
                      }
                    }}
                  >
                    <td>
                      <Group spacing={4}>
                        <Text>{mv.model.name}</Text>
                        {mv.name !== mv.model.name && <Text>({mv.name})</Text>}
                      </Group>
                    </td>
                    <td>
                      <Badge>{splitUppercase(thisTrainingDetails?.type ?? '-')}</Badge>
                    </td>
                    <td>
                      <Text>
                        {isDefined(thisTrainingDetails?.baseModel)
                          ? thisTrainingDetails.baseModel in trainingModelInfo
                            ? trainingModelInfo[
                                thisTrainingDetails.baseModel as TrainingDetailsBaseModelList
                              ].pretty
                            : 'Custom'
                          : '-'}
                      </Text>
                    </td>
                    <td>
                      {mv.trainingStatus ? (
                        <Group spacing="sm">
                          <HoverCard shadow="md" width={300} zIndex={100} withArrow>
                            <HoverCard.Target>
                              <Badge
                                color={trainingStatusFields[mv.trainingStatus]?.color ?? 'gray'}
                              >
                                <Group spacing={6} noWrap>
                                  {splitUppercase(
                                    mv.trainingStatus === TrainingStatus.InReview
                                      ? 'Ready'
                                      : mv.trainingStatus
                                  )}
                                  {isRunning && <Loader size={12} />}
                                </Group>
                              </Badge>
                            </HoverCard.Target>
                            <HoverCard.Dropdown>
                              <Text>
                                {trainingStatusFields[mv.trainingStatus]?.description ?? 'N/A'}
                              </Text>
                            </HoverCard.Dropdown>
                          </HoverCard>
                          {isProcessing && (
                            <>
                              <Divider size="sm" orientation="vertical" />
                              <HoverCard shadow="md" width={250} zIndex={100} withArrow>
                                <HoverCard.Target>
                                  <Badge
                                    variant="filled"
                                    // color={`gray.${Math.max(Math.min(epochsPct, 9), 0)}`}
                                    color={'gray'}
                                  >
                                    {`Progress: ${epochsDone}/${numEpochs}`}
                                  </Badge>
                                </HoverCard.Target>
                                <HoverCard.Dropdown>
                                  <Text>Number of Epochs remaining</Text>
                                </HoverCard.Dropdown>
                              </HoverCard>
                            </>
                          )}
                          {(mv.trainingStatus === TrainingStatus.Failed ||
                            mv.trainingStatus === TrainingStatus.Denied) && (
                            <Button
                              size="xs"
                              color="gray"
                              py={0}
                              sx={{ fontSize: 12, fontWeight: 600, height: 20 }}
                              component="a"
                              href="/support-portal"
                              target="_blank"
                              onMouseUp={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                            >
                              <Group noWrap spacing={6}>
                                Open Support Ticket <IconExternalLink size={12} />
                              </Group>
                            </Button>
                          )}
                        </Group>
                      ) : (
                        <Badge color="gray">N/A</Badge>
                      )}
                    </td>
                    <td>
                      <HoverCard openDelay={400} shadow="md" zIndex={100} withArrow>
                        <HoverCard.Target>
                          <Text>{formatDate(mv.createdAt)}</Text>
                        </HoverCard.Target>
                        {new Date(mv.createdAt).getTime() !== new Date(mv.updatedAt).getTime() && (
                          <HoverCard.Dropdown>
                            <Text>Updated: {formatDate(mv.updatedAt)}</Text>
                          </HoverCard.Dropdown>
                        )}
                      </HoverCard>
                    </td>
                    <td>
                      <Text>{startStr}</Text>
                    </td>
                    <td>
                      <Group spacing={8} noWrap>
                        {!hasFiles || !hasTrainingParams ? (
                          <IconAlertCircle color="orange" />
                        ) : (
                          <IconCircleCheck color="green" />
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
                      <Group position="right" spacing={8} pr="xs" noWrap>
                        {mv.trainingStatus === TrainingStatus.InReview && (
                          <Link legacyBehavior href={getModelTrainingWizardUrl(mv)} passHref>
                            <Button
                              component="a"
                              radius="xl"
                              size="sm"
                              onClick={(e) => e.stopPropagation()}
                              compact
                            >
                              Review
                            </Button>
                          </Link>
                        )}
                        <ActionIcon
                          variant="filled"
                          radius="xl"
                          size="md"
                          onMouseUp={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (e.button !== 0) return;
                            setModalData({
                              id: mv.id,
                              file: thisFile as TrainingFileData,
                              baseModel: thisTrainingDetails?.baseModel,
                              params: thisTrainingDetails?.params,
                            });
                            open();
                          }}
                        >
                          <IconFileDescription size={16} />
                        </ActionIcon>
                        <ActionIcon
                          color="red"
                          variant="light"
                          size="md"
                          radius="xl"
                          onMouseUp={(e) => !isNotDeletable && handleDelete(e, mv)}
                          disabled={isNotDeletable}
                        >
                          <IconTrash size={16} />
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
              value: (
                modalData.file?.metadata?.trainingResults?.version === 2
                  ? modalData.file?.metadata?.trainingResults?.startedAt
                  : modalData.file?.metadata?.trainingResults?.start_time
              )
                ? formatDate(
                    (modalData.file?.metadata?.trainingResults?.version === 2
                      ? modalData.file?.metadata?.trainingResults?.startedAt
                      : modalData.file?.metadata?.trainingResults?.start_time) as unknown as Date,
                    'MMM D, YYYY hh:mm:ss A'
                  )
                : 'Unknown',
            },
            {
              label: 'History',
              value: (
                <Stack spacing={5}>
                  {modalData.file?.metadata?.trainingResults?.history
                    ? (modalData.file?.metadata?.trainingResults?.history || []).map((h) => (
                        <Group key={h.time}>
                          <Text inline>
                            {formatDate(h.time as unknown as Date, 'MM/DD/YYYY hh:mm:ss A')}
                          </Text>
                          <Text inline>
                            <Badge color={trainingStatusFields[h.status]?.color ?? 'gray'}>
                              {splitUppercase(
                                h.status === TrainingStatus.InReview ? 'Ready' : h.status
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
              label: 'Labels',
              value: modalData.file?.metadata?.numCaptions || 0,
            },
            {
              label: 'Label Type',
              value: modalData.file?.metadata?.labelType ?? 'tag',
            },
            // TODO could get the name of the custom model
            {
              label: 'Base Model',
              value: isDefined(modalData.baseModel) ? (
                modalData.baseModel in trainingModelInfo ? (
                  trainingModelInfo[modalData.baseModel as TrainingDetailsBaseModelList].pretty
                ) : isAir(modalData.baseModel) ? (
                  <Link href={getAirModelLink(modalData.baseModel)} passHref legacyBehavior>
                    <Anchor>Custom</Anchor>
                  </Link>
                ) : (
                  modalData.baseModel
                )
              ) : (
                '-'
              ),
            },
            {
              label: 'Privacy',
              value: (
                <Group>
                  <Badge
                    color={modalData.file?.metadata?.ownRights === true ? 'green' : 'red'}
                    leftSection={
                      modalData.file?.metadata?.ownRights === true ? (
                        <IconCheck size={14} />
                      ) : (
                        <IconX size={14} />
                      )
                    }
                  >
                    Own Rights
                  </Badge>
                  <Badge
                    color={modalData.file?.metadata?.shareDataset === true ? 'green' : 'red'}
                    leftSection={
                      modalData.file?.metadata?.shareDataset === true ? (
                        <IconCheck size={14} />
                      ) : (
                        <IconX size={14} />
                      )
                    }
                  >
                    Share Dataset
                  </Badge>
                </Group>
              ),
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
                  <Text align="center">{`Download (${formatKBytes(modalData.file?.sizeKB)})`}</Text>
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
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                        {modalData.params.engine === 'rapid'
                          ? JSON.stringify({ engine: modalData.params.engine }, null, 2)
                          : JSON.stringify(modalData.params, null, 2)}
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
    </Stack>
  );
}
