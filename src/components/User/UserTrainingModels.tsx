import {
  Accordion,
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Center,
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
  Box,
  BoxProps,
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
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useState, forwardRef } from 'react';
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
import styles from './UserTrainingModels.module.scss';

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

export interface UserTrainingModelsProps extends BoxProps {
  scrolled?: boolean;
}

export const UserTrainingModels = forwardRef<HTMLDivElement, UserTrainingModelsProps>((props, ref) => {
  const { scrolled, className, ...others } = props;

  return (
    <Box
      className={`${styles.header} ${scrolled ? styles.scrolled : ''} ${className}`}
      {...others}
      ref={ref}
    />
  );
});

UserTrainingModels.displayName = 'UserTrainingModels';

export default function UserTrainingModels() {
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
        <Text>
          Training is currently in beta. Please report any issues you encounter to our{' '}
          <Link href="/feedback" target="_blank">
            feedback page
          </Link>
          .
        </Text>
      </AlertWithIcon>
      <ScrollArea
        // TODO [bw] this 600px here should be autocalced via a css var, to capture the top nav, user info section, and bottom bar
        style={{ height: 'max(400px, calc(100vh - 600px))' }}
        onScrollPositionChange={({ y }) => setScrolled(y !== 0)}
      >
        <Table verticalSpacing="md" fontSize="md" striped={hasTraining}>
          <thead className={styles.header}>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th>Created</th>
              <th>Last Updated</th>
              <th>Missing Info</th>
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
                const hasVersion = model._count.modelVersions > 0;
                const hasFiles = model.modelVersions.some((version) => version._count.files > 0);
                const hasPosts = model.modelVersions.some((version) => version._count.posts > 0);

                return (
                  <tr key={model.id}>
                    <td>
                      <Stack spacing={0}>
                        <Text lineClamp={2}> {model.name}</Text>
                        <Divider my={4} />
                        <Link legacyBehavior href={getModelTrainingWizardUrl(model)} passHref>
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
