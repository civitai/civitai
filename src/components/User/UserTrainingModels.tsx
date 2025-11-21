import {
  Accordion,
  Anchor,
  Badge,
  Button,
  Center,
  Divider,
  Group,
  HoverCard,
  Loader,
  LoadingOverlay,
  Modal,
  Pagination,
  ScrollArea,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useClipboard, useDisclosure } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconAlertCircle,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconExclamationCircle,
  IconExternalLink,
  IconFileDescription,
  IconRefresh,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { TrainStatusMessage } from '~/components/Training/Wizard/TrainWizard';
import {
  createModelFileDownloadUrl,
  getModelTrainingWizardUrl,
} from '~/server/common/model-helpers';
import type {
  TrainingDetailsBaseModelList,
  TrainingDetailsObj,
  // TrainingDetailsParams,
  TrainingDetailsParamsUnion,
} from '~/server/schema/model-version.schema';
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import type { MyTrainingModelGetAll } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { getAirModelLink, isAir, splitUppercase } from '~/utils/string-helpers';
import { trainingModelInfo } from '~/utils/training';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import styles from './UserModelsTable.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';
import { showErrorNotification } from '~/utils/notifications';
import { trainingStatusFields } from '~/shared/constants/training.constants';

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
  params?: TrainingDetailsParamsUnion;
};

const modelsLimit = 10;

export default function UserTrainingModels() {
  const queryUtils = trpc.useUtils();
  const router = useRouter();
  const { copied, copy } = useClipboard();

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
  const recheckTrainingStatusMutation = trpc.modelVersion.recheckTrainingStatus.useMutation({
    onSuccess: async () => {
      await queryUtils.model.getMyTrainingModels.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to recheck training status',
        error: new Error(error.message),
      });
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

  const handleRecheckTrainingStatus = (
    e: React.MouseEvent<HTMLButtonElement>,
    modelVersion: MyTrainingModelGetAll['items'][number]
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;

    recheckTrainingStatusMutation.mutate({ id: modelVersion.id });
  };

  const hasTraining = items.length > 0;
  const jobId =
    modalData.file?.metadata?.trainingResults?.version === 2
      ? modalData.file?.metadata?.trainingResults?.workflowId
      : modalData.file?.metadata?.trainingResults?.jobId;

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
          className="text-base"
          striped={hasTraining}
          highlightOnHover={hasTraining}
        >
          <Table.Thead className={clsx(styles.header, { [styles.scrolled]: scrolled })}>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Model</Table.Th>
              <Table.Th>Training Status</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th>Start</Table.Th>
              <Table.Th>Missing Info</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {isLoading && (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <LoadingOverlay visible={true} />
                </Table.Td>
              </Table.Tr>
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

                const numEpochs =
                  trainingParams?.engine === 'ai-toolkit'
                    ? trainingParams?.epochs ?? 0
                    : trainingParams?.maxTrainEpochs ?? 0;
                const epochsDone =
                  (thisFileMetadata?.trainingResults?.version === 2
                    ? thisFileMetadata?.trainingResults?.epochs?.slice(-1)[0]?.epochNumber ?? 0
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
                  <Table.Tr
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
                    <Table.Td>
                      <Group gap={4}>
                        <Text>{mv.model.name}</Text>
                        {mv.name !== mv.model.name && <Text>({mv.name})</Text>}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge>{splitUppercase(thisTrainingDetails?.type ?? '-')}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text>
                        {isDefined(thisTrainingDetails?.baseModel)
                          ? thisTrainingDetails.baseModel in trainingModelInfo
                            ? trainingModelInfo[
                                thisTrainingDetails.baseModel as TrainingDetailsBaseModelList
                              ].pretty
                            : 'Custom'
                          : '-'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {mv.trainingStatus ? (
                        <Group gap="sm">
                          <HoverCard shadow="md" width={300} zIndex={100} withArrow>
                            <HoverCard.Target>
                              <Badge
                                color={trainingStatusFields[mv.trainingStatus]?.color ?? 'gray'}
                              >
                                <Group gap={6} wrap="nowrap">
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
                              style={{ fontSize: 12, fontWeight: 600, height: 20 }}
                              component="a"
                              href="/support-portal"
                              target="_blank"
                              onMouseUp={(e: React.MouseEvent<HTMLAnchorElement>) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                            >
                              <Group wrap="nowrap" gap={6}>
                                Open Support Ticket <IconExternalLink size={12} />
                              </Group>
                            </Button>
                          )}
                        </Group>
                      ) : (
                        <Badge color="gray">N/A</Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
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
                    </Table.Td>
                    <Table.Td>
                      <Text>{startStr}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={8} wrap="nowrap">
                        {!hasFiles || !hasTrainingParams ? (
                          <IconAlertCircle color="orange" />
                        ) : (
                          <IconCircleCheck color="green" />
                        )}
                        <Stack gap={4}>
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
                    </Table.Td>
                    <Table.Td>
                      <Group justify="flex-end" gap={8} pr="xs" wrap="nowrap">
                        {mv.trainingStatus === TrainingStatus.InReview && (
                          <Link legacyBehavior href={getModelTrainingWizardUrl(mv)} passHref>
                            <Button
                              component="a"
                              radius="xl"
                              onClick={(e: React.MouseEvent<HTMLAnchorElement>) =>
                                e.stopPropagation()
                              }
                              size="compact-sm"
                            >
                              Review
                            </Button>
                          </Link>
                        )}
                        {mv.trainingStatus === TrainingStatus.Failed && (
                          <Tooltip label="Recheck Training Status" withArrow>
                            <LegacyActionIcon
                              variant="light"
                              size="md"
                              radius="xl"
                              loading={
                                recheckTrainingStatusMutation.isLoading &&
                                recheckTrainingStatusMutation.variables?.id === mv.id
                              }
                              onMouseUp={(e: React.MouseEvent<HTMLButtonElement>) =>
                                handleRecheckTrainingStatus(e, mv)
                              }
                            >
                              <IconRefresh size={16} />
                            </LegacyActionIcon>
                          </Tooltip>
                        )}
                        <Tooltip label="View Details" withArrow>
                          <LegacyActionIcon
                            variant="filled"
                            radius="xl"
                            size="md"
                            onMouseUp={(e: React.MouseEvent<HTMLButtonElement>) => {
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
                          </LegacyActionIcon>
                        </Tooltip>
                        <LegacyActionIcon
                          color="red"
                          variant="light"
                          size="md"
                          radius="xl"
                          onMouseUp={(e: React.MouseEvent<HTMLButtonElement>) =>
                            !isNotDeletable && handleDelete(e, mv)
                          }
                          disabled={isNotDeletable}
                        >
                          <IconTrash size={16} />
                        </LegacyActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                  // </Link>
                );
              })
            ) : !isLoading ? (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <Center py="md">
                    <NoContent message="You have no training models" />
                  </Center>
                </Table.Td>
              </Table.Tr>
            ) : (
              <></>
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
      <Modal
        opened={opened}
        title="Training Details"
        scrollAreaComponent={ScrollArea.Autosize}
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
              label: 'Job ID',
              value: (
                <Group gap="xs">
                  <Text>{jobId ?? 'Unknown'}</Text>
                  {!!jobId && (
                    <ButtonTooltip withinPortal withArrow label="Copy - send this to support!">
                      <LegacyActionIcon size={18} p={0} onClick={() => copy(jobId)}>
                        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                      </LegacyActionIcon>
                    </ButtonTooltip>
                  )}
                </Group>
              ),
            },
            {
              label: 'History',
              value: (
                <Stack gap={5}>
                  {modalData.file?.metadata?.trainingResults?.history
                    ? (modalData.file?.metadata?.trainingResults?.history || []).map((h) => (
                        <Group key={h.time}>
                          <Text inline>
                            {formatDate(h.time as unknown as Date, 'MM/DD/YYYY hh:mm:ss A')}
                          </Text>
                          <Text component="div" inline>
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
              label: 'Files',
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
                  style={{ flex: 1 }}
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
