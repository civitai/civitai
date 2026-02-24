import {
  Accordion,
  Anchor,
  Badge,
  Button,
  Center,
  Checkbox,
  Divider,
  Group,
  HoverCard,
  Loader,
  Modal,
  Popover,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue, useClipboard, useDisclosure } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconAlertCircle,
  IconCheck,
  IconChevronDown,
  IconCircleCheck,
  IconClock,
  IconCopy,
  IconExclamationCircle,
  IconExternalLink,
  IconFileDescription,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
  IconCurrencyDollar,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useMemo, useState } from 'react';
import type { MRT_ColumnDef, MRT_SortingState } from 'mantine-react-table';
import { MantineReactTable } from 'mantine-react-table';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
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
import { showErrorNotification } from '~/utils/notifications';
import { trainingStatusFields } from '~/shared/constants/training.constants';
import type { TrainingModelsSort } from '~/server/schema/model.schema';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';

type TrainingFileData = {
  type: string;
  metadata: FileMetadata;
  url: string;
  sizeKB: number;
  dataPurged?: boolean;
};

type ModalData = {
  id?: number;
  file?: TrainingFileData;
  baseModel?: string;
  params?: TrainingDetailsParamsUnion;
};

type RefundInfo = {
  isRefunded: boolean;
  yellowBuzz?: number;
  blueBuzz?: number;
  greenBuzz?: number;
};

type CostInfo = {
  yellowBuzz?: number;
  blueBuzz?: number;
  greenBuzz?: number;
};

type TrainingModelRow = MyTrainingModelGetAll['items'][number] & {
  startDate: Date | null;
  endDate: Date | null;
  trainingType: string;
  baseModelPretty: string;
  refundInfo: RefundInfo | null;
  costInfo: CostInfo | null;
};

const DEFAULT_PAGE_SIZE = 10;

// Helper to extract dates and other derived info from training data
function enrichTrainingData(items: MyTrainingModelGetAll['items']): TrainingModelRow[] {
  return items.map((mv) => {
    const thisTrainingDetails = mv.trainingDetails as TrainingDetailsObj | undefined;
    const thisFile = mv.files[0];
    const thisFileMetadata = thisFile?.metadata as FileMetadata | null;
    const trainingResults = thisFileMetadata?.trainingResults;

    // Extract start date
    let startDate: Date | null = null;
    if (trainingResults) {
      const startStr =
        trainingResults.version === 2
          ? trainingResults.startedAt ?? trainingResults.submittedAt
          : trainingResults.start_time ?? trainingResults.submittedAt;
      if (startStr) {
        startDate = new Date(startStr);
      }
    }

    // Extract end date
    let endDate: Date | null = null;
    if (trainingResults) {
      const endStr =
        trainingResults.version === 2 ? trainingResults.completedAt : trainingResults.end_time;
      if (endStr) {
        endDate = new Date(endStr);
      }
    }

    // Extract cost info (from V2 transactionData - debit transactions)
    let costInfo: CostInfo | null = null;
    if (trainingResults?.version === 2 && trainingResults.transactionData) {
      const costTxs = trainingResults.transactionData.filter((tx) => tx.type === 'debit');
      if (costTxs.length > 0) {
        const yellowTx = costTxs.find((tx) => tx.accountType === 'yellow');
        const blueTx = costTxs.find((tx) => tx.accountType === 'blue');
        const greenTx = costTxs.find((tx) => tx.accountType === 'green');
        costInfo = {
          yellowBuzz: yellowTx?.amount,
          blueBuzz: blueTx?.amount,
          greenBuzz: greenTx?.amount,
        };
      }
    }

    // Extract refund info (from V2 transactionData - credit transactions)
    let refundInfo: RefundInfo | null = null;
    if (trainingResults?.version === 2 && trainingResults.transactionData) {
      const refundTxs = trainingResults.transactionData.filter((tx) => tx.type === 'credit');
      if (refundTxs.length > 0) {
        const yellowTx = refundTxs.find((tx) => tx.accountType === 'yellow');
        const blueTx = refundTxs.find((tx) => tx.accountType === 'blue');
        const greenTx = refundTxs.find((tx) => tx.accountType === 'green');
        refundInfo = {
          isRefunded: true,
          yellowBuzz: yellowTx?.amount,
          blueBuzz: blueTx?.amount,
          greenBuzz: greenTx?.amount,
        };
      } else if (mv.trainingStatus === TrainingStatus.Failed) {
        // Failed but no refund transaction yet
        refundInfo = { isRefunded: false };
      }
    } else if (mv.trainingStatus === TrainingStatus.Failed) {
      // V1 or no transactionData - we don't know refund status
      refundInfo = { isRefunded: false };
    }

    // Get training type and base model
    const trainingType = thisTrainingDetails?.type ?? '-';
    const baseModelPretty = isDefined(thisTrainingDetails?.baseModel)
      ? thisTrainingDetails.baseModel in trainingModelInfo
        ? trainingModelInfo[thisTrainingDetails.baseModel as TrainingDetailsBaseModelList].pretty
        : 'Custom'
      : '-';

    return {
      ...mv,
      startDate,
      endDate,
      trainingType,
      baseModelPretty,
      refundInfo,
      costInfo,
    };
  });
}

export default function UserTrainingModels() {
  const queryUtils = trpc.useUtils();
  const router = useRouter();
  const { copied, copy } = useClipboard();

  // Fetch moderator-editable announcement
  const { data: announcement } = trpc.training.getAnnouncement.useQuery();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [modalData, setModalData] = useState<ModalData>({});
  const [opened, { open, close }] = useDisclosure(false);

  // External filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch] = useDebouncedValue(searchQuery, 300);
  const [statusFilter, setStatusFilter] = useState<TrainingStatus[]>([]);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [baseModelFilter, setBaseModelFilter] = useState<string | null>(null);
  const [hidePending, setHidePending] = useState(false);
  const [hideFailed, setHideFailed] = useState(false);

  // Build effective status filter based on toggles
  const effectiveStatusFilter = useMemo(() => {
    if (statusFilter.length > 0) return statusFilter;
    if (!hidePending && !hideFailed) return undefined;

    // Get all statuses except the hidden ones
    const allStatuses = Object.values(TrainingStatus);
    return allStatuses.filter((s) => {
      if (hidePending && s === TrainingStatus.Pending) return false;
      if (hideFailed && s === TrainingStatus.Failed) return false;
      return true;
    });
  }, [statusFilter, hidePending, hideFailed]);

  // Sort state for table column headers
  const [sorting, setSorting] = useState<MRT_SortingState>([{ id: 'startDate', desc: true }]);

  // Convert MRT sorting to our sort format
  const sort: TrainingModelsSort = useMemo(() => {
    if (sorting.length === 0) return 'startDesc';
    const { id, desc } = sorting[0];
    switch (id) {
      case 'startDate':
        return desc ? 'startDesc' : 'startAsc';
      case 'endDate':
        return desc ? 'endDesc' : 'endAsc';
      default:
        return 'startDesc';
    }
  }, [sorting]);

  // Reset page when filters change
  const handleFilterChange = () => setPage(1);

  const { data, isLoading, isFetching } = trpc.model.getMyTrainingModels.useQuery({
    page,
    limit: pageSize,
    query: debouncedSearch || undefined,
    trainingStatus: effectiveStatusFilter,
    type: typeFilter || undefined,
    baseModel: baseModelFilter || undefined,
    sort,
  });
  const { items: rawItems, ...pagination } = data || {
    items: [],
    totalItems: 0,
    currentPage: 1,
    pageSize,
    totalPages: 1,
  };

  // Enrich items with derived data
  const items = useMemo(() => enrichTrainingData(rawItems), [rawItems]);

  const deleteMutation = trpc.modelVersion.delete.useMutation({
    onSuccess: async () => {
      await queryUtils.model.getMyTrainingModels.invalidate();
    },
  });
  const deleteModelMutation = trpc.model.delete.useMutation({
    onSuccess: async () => {
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

  const goToModel = (e: React.MouseEvent, href: string) => {
    if (opened) return false;
    if ((e.ctrlKey && e.button === 0) || e.button === 1) {
      e.preventDefault();
      window.open(href, '_blank');
    } else if (e.button === 0) {
      router.push(href).then();
    }
  };

  const handleDelete = (e: React.MouseEvent<HTMLButtonElement>, modelVersion: TrainingModelRow) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;

    if (modelVersion.model._count.modelVersions > 1) {
      handleDeleteVersion(modelVersion);
    } else {
      handleDeleteModel(modelVersion);
    }
  };

  const handleDeleteVersion = (modelVersion: TrainingModelRow) => {
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

  const handleDeleteModel = (modelVersion: TrainingModelRow) => {
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
    modelVersion: TrainingModelRow
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

  // Define columns
  const columns = useMemo<MRT_ColumnDef<TrainingModelRow>[]>(
    () => [
      {
        accessorKey: 'model.name',
        header: 'Name',
        id: 'name',
        enableSorting: false,
        Cell: ({ row }) => (
          <Group gap={4} wrap="nowrap">
            <Text lineClamp={1}>{row.original.model.name}</Text>
            {row.original.name !== row.original.model.name && (
              <Text c="dimmed" size="sm">
                ({row.original.name})
              </Text>
            )}
          </Group>
        ),
      },
      {
        accessorKey: 'trainingType',
        header: 'Type',
        id: 'trainingType',
        enableSorting: false,
        size: 100,
        Cell: ({ row }) => <Badge size="sm">{splitUppercase(row.original.trainingType)}</Badge>,
      },
      {
        accessorKey: 'baseModelPretty',
        header: 'Model',
        id: 'baseModelPretty',
        enableSorting: false,
        size: 120,
        Cell: ({ row }) => <Text size="sm">{row.original.baseModelPretty}</Text>,
      },
      {
        accessorKey: 'trainingStatus',
        header: 'Status',
        id: 'trainingStatus',
        enableSorting: false,
        Cell: ({ row }) => {
          const mv = row.original;
          const thisTrainingDetails = mv.trainingDetails as TrainingDetailsObj | undefined;
          const thisFile = mv.files[0];
          const thisFileMetadata = thisFile?.metadata as FileMetadata | null;
          const isDataPurged = thisFile?.dataPurged === true;

          const isSubmitted = mv.trainingStatus === TrainingStatus.Submitted;
          const isProcessing = mv.trainingStatus === TrainingStatus.Processing;
          const isFailed = mv.trainingStatus === TrainingStatus.Failed;
          const isRunning = isSubmitted || isProcessing;

          const trainingParams = thisTrainingDetails?.params;
          const numEpochs =
            trainingParams?.engine === 'ai-toolkit'
              ? trainingParams?.epochs ?? 0
              : trainingParams?.maxTrainEpochs ?? 0;
          const epochsDone =
            (thisFileMetadata?.trainingResults?.version === 2
              ? thisFileMetadata?.trainingResults?.epochs?.slice(-1)[0]?.epochNumber ?? 0
              : thisFileMetadata?.trainingResults?.epochs?.slice(-1)[0]?.epoch_number) ?? 0;
          const hasFailedWithEpochs = isFailed && epochsDone > 0;

          if (!mv.trainingStatus) return <Badge color="gray">N/A</Badge>;

          if (isDataPurged) {
            return (
              <HoverCard shadow="md" width={300} zIndex={100} withArrow withinPortal>
                <HoverCard.Target>
                  <Badge color="orange">Files Expired</Badge>
                </HoverCard.Target>
                <HoverCard.Dropdown>
                  <Text size="sm">
                    Training files have been automatically removed after 30 days. Epoch files and
                    sample images are no longer available. To train a new model, please start a new
                    training run.
                  </Text>
                </HoverCard.Dropdown>
              </HoverCard>
            );
          }

          return (
            <Group gap="sm">
              <HoverCard shadow="md" width={300} zIndex={100} withArrow withinPortal>
                <HoverCard.Target>
                  <Badge color={trainingStatusFields[mv.trainingStatus]?.color ?? 'gray'}>
                    <Group gap={6} wrap="nowrap">
                      {splitUppercase(
                        mv.trainingStatus === TrainingStatus.InReview ? 'Ready' : mv.trainingStatus
                      )}
                      {isRunning && <Loader size={12} />}
                    </Group>
                  </Badge>
                </HoverCard.Target>
                <HoverCard.Dropdown>
                  <Text>{trainingStatusFields[mv.trainingStatus]?.description ?? 'N/A'}</Text>
                </HoverCard.Dropdown>
              </HoverCard>
              {isProcessing && (
                <>
                  <Divider size="sm" orientation="vertical" />
                  <HoverCard shadow="md" width={250} zIndex={100} withArrow withinPortal>
                    <HoverCard.Target>
                      <Badge variant="filled" color="gray">
                        {`Progress: ${epochsDone}/${numEpochs}`}
                      </Badge>
                    </HoverCard.Target>
                    <HoverCard.Dropdown>
                      <Text>Number of Epochs remaining</Text>
                    </HoverCard.Dropdown>
                  </HoverCard>
                </>
              )}
              {hasFailedWithEpochs && (
                <>
                  <Divider size="sm" orientation="vertical" />
                  <HoverCard shadow="md" width={250} zIndex={100} withArrow withinPortal>
                    <HoverCard.Target>
                      <Badge variant="filled" color="yellow">
                        {`${epochsDone} epoch${epochsDone > 1 ? 's' : ''} available`}
                      </Badge>
                    </HoverCard.Target>
                    <HoverCard.Dropdown>
                      <Text>
                        Training failed but {epochsDone} epoch
                        {epochsDone > 1 ? 's were' : ' was'} completed
                      </Text>
                    </HoverCard.Dropdown>
                  </HoverCard>
                </>
              )}
              {(mv.trainingStatus === TrainingStatus.Failed ||
                mv.trainingStatus === TrainingStatus.Denied) && (
                <>
                  <Divider size="sm" orientation="vertical" />
                  <HoverCard shadow="md" width={300} zIndex={100} withArrow withinPortal>
                    <HoverCard.Target>
                      <IconAlertCircle size={20} color="orange" style={{ cursor: 'pointer' }} />
                    </HoverCard.Target>
                    <HoverCard.Dropdown>
                      <Text size="sm">
                        Training success can vary based on system conditions and configuration.
                        Check for service updates at the top of the page or on the{' '}
                        <Anchor href="/changelog" target="_blank">
                          Updates page
                        </Anchor>{' '}
                        for any relevant LoRA training notices before retrying.
                      </Text>
                    </HoverCard.Dropdown>
                  </HoverCard>
                </>
              )}
            </Group>
          );
        },
      },
      {
        accessorKey: 'startDate',
        header: 'Start',
        id: 'startDate',
        size: 150,
        Cell: ({ row }) => (
          <Text size="sm">
            {row.original.startDate
              ? formatDate(row.original.startDate, 'MMM D, YYYY h:mm A')
              : '-'}
          </Text>
        ),
      },
      {
        accessorKey: 'endDate',
        header: 'End',
        id: 'endDate',
        size: 150,
        Cell: ({ row }) => (
          <Text size="sm">
            {row.original.endDate ? formatDate(row.original.endDate, 'MMM D, YYYY h:mm A') : '-'}
          </Text>
        ),
      },
      {
        id: 'cost',
        header: 'Cost',
        enableSorting: false,
        size: 140,
        Cell: ({ row }) => {
          const mv = row.original;
          if (!mv.costInfo) return <Text size="sm">-</Text>;

          const hasCost = mv.costInfo.yellowBuzz || mv.costInfo.blueBuzz || mv.costInfo.greenBuzz;
          if (!hasCost) return <Text size="sm">-</Text>;

          return (
            <Group gap={4} wrap="nowrap">
              {mv.costInfo.yellowBuzz && (
                <Badge variant="light" color="yellow" size="sm">
                  {mv.costInfo.yellowBuzz.toLocaleString()}
                </Badge>
              )}
              {mv.costInfo.blueBuzz && (
                <Badge variant="light" color="blue" size="sm">
                  {mv.costInfo.blueBuzz.toLocaleString()}
                </Badge>
              )}
              {mv.costInfo.greenBuzz && (
                <Badge variant="light" color="green" size="sm">
                  {mv.costInfo.greenBuzz.toLocaleString()}
                </Badge>
              )}
            </Group>
          );
        },
      },
      {
        id: 'refund',
        header: 'Refund',
        enableSorting: false,
        size: 140,
        Cell: ({ row }) => {
          const mv = row.original;
          if (!mv.refundInfo) return null;

          if (!mv.refundInfo.isRefunded) {
            return (
              <Badge variant="light" color="orange" size="sm">
                Pending
              </Badge>
            );
          }

          return (
            <Group gap={4} wrap="nowrap">
              {mv.refundInfo.yellowBuzz && (
                <Badge variant="filled" color="yellow" size="sm">
                  {mv.refundInfo.yellowBuzz.toLocaleString()}
                </Badge>
              )}
              {mv.refundInfo.blueBuzz && (
                <Badge variant="filled" color="blue" size="sm">
                  {mv.refundInfo.blueBuzz.toLocaleString()}
                </Badge>
              )}
              {mv.refundInfo.greenBuzz && (
                <Badge variant="filled" color="green" size="sm">
                  {mv.refundInfo.greenBuzz.toLocaleString()}
                </Badge>
              )}
              {!mv.refundInfo.yellowBuzz && !mv.refundInfo.blueBuzz && !mv.refundInfo.greenBuzz && (
                <Badge variant="light" color="green" size="sm">
                  Refunded
                </Badge>
              )}
            </Group>
          );
        },
      },
      {
        id: 'missingInfo',
        header: 'Info',
        enableSorting: false,
        size: 80,
        Cell: ({ row }) => {
          const mv = row.original;
          const thisTrainingDetails = mv.trainingDetails as TrainingDetailsObj | undefined;
          const thisFile = mv.files[0];
          const isDataPurged = thisFile?.dataPurged === true;

          const isFailed = mv.trainingStatus === TrainingStatus.Failed;
          const hasFiles = !!thisFile;
          const hasTrainingParams = !!thisTrainingDetails?.params;
          const needsInfo = !hasFiles || !hasTrainingParams;

          if (isDataPurged) {
            return (
              <Tooltip label="Files expired after 30 days" withArrow withinPortal>
                <Center>
                  <IconX color="orange" size={20} />
                </Center>
              </Tooltip>
            );
          }

          if (isFailed) {
            return (
              <Tooltip label="Failed!" withArrow withinPortal>
                <Center>
                  <IconX color="red" size={20} />
                </Center>
              </Tooltip>
            );
          }

          return (
            <Tooltip
              label={
                needsInfo
                  ? `${!hasFiles ? 'Needs training files (Step 2)' : ''} ${
                      !hasTrainingParams ? 'Needs training parameters (Step 3)' : ''
                    }`
                  : 'All good!'
              }
              withArrow
              withinPortal
            >
              <Center>
                {needsInfo ? (
                  <IconAlertCircle color="orange" size={20} />
                ) : (
                  <IconCircleCheck color="green" size={20} />
                )}
              </Center>
            </Tooltip>
          );
        },
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        size: 160,
        Cell: ({ row }) => {
          const mv = row.original;
          const thisTrainingDetails = mv.trainingDetails as TrainingDetailsObj | undefined;
          const thisFile = mv.files[0];
          const thisFileMetadata = thisFile?.metadata as FileMetadata | null;
          const isDataPurged = thisFile?.dataPurged === true;

          const isSubmitted = mv.trainingStatus === TrainingStatus.Submitted;
          const isProcessing = mv.trainingStatus === TrainingStatus.Processing;
          const isPaused = mv.trainingStatus === TrainingStatus.Paused;
          const isFailed = mv.trainingStatus === TrainingStatus.Failed;
          const isRunning = isSubmitted || isProcessing;
          const isNotDeletable = isRunning || isPaused;

          const epochsDone =
            (thisFileMetadata?.trainingResults?.version === 2
              ? thisFileMetadata?.trainingResults?.epochs?.slice(-1)[0]?.epochNumber ?? 0
              : thisFileMetadata?.trainingResults?.epochs?.slice(-1)[0]?.epoch_number) ?? 0;
          const hasFailedWithEpochs = isFailed && epochsDone > 0;

          return (
            <Group justify="flex-end" gap={8} pr="xs" wrap="nowrap">
              {mv.trainingStatus === TrainingStatus.InReview && !isDataPurged && (
                <Link legacyBehavior href={getModelTrainingWizardUrl(mv)} passHref>
                  <Button
                    component="a"
                    radius="xl"
                    onClick={(e: React.MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
                    size="compact-sm"
                  >
                    Review
                  </Button>
                </Link>
              )}
              {hasFailedWithEpochs && !isDataPurged && (
                <Link legacyBehavior href={getModelTrainingWizardUrl(mv)} passHref>
                  <Button
                    component="a"
                    radius="xl"
                    color="yellow"
                    onClick={(e: React.MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
                    size="compact-sm"
                  >
                    View Epochs
                  </Button>
                </Link>
              )}
              <Tooltip label="Recheck Training Status" withArrow withinPortal>
                <LegacyActionIcon
                  variant="light"
                  size="md"
                  radius="xl"
                  loading={
                    recheckTrainingStatusMutation.isLoading &&
                    recheckTrainingStatusMutation.variables?.id === mv.id
                  }
                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                    e.stopPropagation();
                    handleRecheckTrainingStatus(e, mv);
                  }}
                >
                  <IconRefresh size={16} />
                </LegacyActionIcon>
              </Tooltip>
              <Tooltip label="View Details" withArrow withinPortal>
                <LegacyActionIcon
                  variant="filled"
                  radius="xl"
                  size="md"
                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                    e.stopPropagation();
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
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.stopPropagation();
                  if (!isNotDeletable) handleDelete(e, mv);
                }}
                disabled={isNotDeletable}
              >
                <IconTrash size={16} />
              </LegacyActionIcon>
            </Group>
          );
        },
      },
    ],
    [recheckTrainingStatusMutation.isLoading, recheckTrainingStatusMutation.variables?.id, open]
  );

  return (
    <Stack gap="md">
      <TrainStatusMessage />
      {announcement?.message && (
        <AlertWithIcon
          icon={<IconExclamationCircle size={16} />}
          iconColor={announcement.color || 'yellow'}
          color={announcement.color || 'yellow'}
          size="sm"
        >
          <CustomMarkdown>{announcement.message}</CustomMarkdown>
        </AlertWithIcon>
      )}

      {/* Filter Bar */}
      <Group gap="sm" wrap="wrap">
        <TextInput
          placeholder="Search by name..."
          leftSection={<IconSearch size={16} />}
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.currentTarget.value);
            handleFilterChange();
          }}
          style={{ flex: 1, maxWidth: 300 }}
        />
        <Select
          placeholder="Type"
          data={['Character', 'Style', 'Concept', 'Effect'].map((t) => ({
            label: t,
            value: t,
          }))}
          value={typeFilter}
          onChange={(value) => {
            setTypeFilter(value);
            handleFilterChange();
          }}
          clearable
          w={130}
        />
        <Select
          placeholder="Model"
          data={Object.entries(trainingModelInfo).map(([key, info]) => ({
            label: info.pretty,
            value: key,
          }))}
          value={baseModelFilter}
          onChange={(value) => {
            setBaseModelFilter(value);
            handleFilterChange();
          }}
          clearable
          w={150}
        />
        <Popover position="bottom-start" withArrow shadow="md">
          <Popover.Target>
            <Button variant="default" rightSection={<IconChevronDown size={14} />} w={140}>
              {statusFilter.length === 0 ? 'Status' : `${statusFilter.length} selected`}
            </Button>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="xs">
              {Object.values(TrainingStatus).map((s) => (
                <Checkbox
                  key={s}
                  label={s === TrainingStatus.InReview ? 'Ready' : splitUppercase(s)}
                  checked={statusFilter.includes(s)}
                  onChange={(e) => {
                    if (e.currentTarget.checked) {
                      setStatusFilter([...statusFilter, s]);
                    } else {
                      setStatusFilter(statusFilter.filter((f) => f !== s));
                    }
                    handleFilterChange();
                  }}
                />
              ))}
              {statusFilter.length > 0 && (
                <>
                  <Divider />
                  <Button
                    variant="subtle"
                    size="xs"
                    onClick={() => {
                      setStatusFilter([]);
                      handleFilterChange();
                    }}
                  >
                    Clear all
                  </Button>
                </>
              )}
            </Stack>
          </Popover.Dropdown>
        </Popover>
        <Switch
          label="Hide Pending"
          checked={hidePending}
          onChange={(e) => {
            setHidePending(e.currentTarget.checked);
            handleFilterChange();
          }}
        />
        <Switch
          label="Hide Failed"
          checked={hideFailed}
          onChange={(e) => {
            setHideFailed(e.currentTarget.checked);
            handleFilterChange();
          }}
        />
      </Group>

      <Group gap={6}>
        <IconClock size={16} color="var(--mantine-color-dimmed)" />
        <Text size="sm" c="dimmed">
          Trained LoRAs are kept in the Trainer for 30 days. Download or Publish them to your
          Profile to save them.
        </Text>
      </Group>

      {!hasTraining && !isLoading ? (
        <Center py="md">
          <NoContent message="You have no training models" />
        </Center>
      ) : (
        <MantineReactTable
          columns={columns}
          data={items}
          manualPagination
          manualSorting
          onPaginationChange={(updater) => {
            const newPagination =
              typeof updater === 'function' ? updater({ pageIndex: page - 1, pageSize }) : updater;
            setPage(newPagination.pageIndex + 1);
            if (newPagination.pageSize !== pageSize) {
              setPageSize(newPagination.pageSize);
              setPage(1); // Reset to first page when changing page size
            }
          }}
          onSortingChange={setSorting}
          enableMultiSort={false}
          enableColumnFilters={false}
          rowCount={pagination.totalItems}
          enableStickyHeader
          enableHiding={false}
          enableGlobalFilter={false}
          enableColumnActions={false}
          enableDensityToggle={false}
          enableFullScreenToggle={false}
          mantineTableContainerProps={{
            style: { maxHeight: 'calc(100vh - 400px)' },
          }}
          mantineTableBodyRowProps={({ row }) => ({
            onClick: (e) => goToModel(e, getModelTrainingWizardUrl(row.original)),
            style: { cursor: 'pointer' },
          })}
          mantineTableHeadCellProps={{
            style: { padding: '8px 12px' },
          }}
          mantineTableBodyCellProps={{
            style: { padding: '8px 12px' },
          }}
          initialState={{
            density: 'xs',
            sorting: [{ id: 'startDate', desc: true }],
          }}
          state={{
            isLoading,
            pagination: { pageIndex: page - 1, pageSize },
            showProgressBars: isFetching,
            sorting,
          }}
        />
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
              value: modalData.file?.dataPurged ? (
                <Text c="dimmed" size="sm">
                  Files expired after 30 days
                </Text>
              ) : modalData.file?.url ? (
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
