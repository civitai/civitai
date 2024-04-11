import {
  ActionIcon,
  Alert,
  Badge,
  Card,
  createStyles,
  MantineColor,
  Text,
  Tooltip,
  TooltipProps,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import {
  IconAlertTriangleFilled,
  IconArrowsShuffle,
  IconCheck,
  IconInfoHexagon,
  IconTrash,
  IconX,
} from '@tabler/icons-react';

import { Currency } from '@prisma/client';
import dayjs from 'dayjs';
import { useMemo } from 'react';
import { Collection } from '~/components/Collection/Collection';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { GeneratedImage, GenerationPlaceholder } from '~/components/ImageGeneration/GeneratedImage';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import {
  useGenerationStatus,
  useUnstableResources,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { GenerationStatusBadge } from '~/components/ImageGeneration/GenerationStatusBadge';
import {
  useDeleteGenerationRequest,
  useDeleteGenerationRequestImages,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { constants } from '~/server/common/constants';
import { GenerationRequestStatus } from '~/server/common/enums';
import { Generation } from '~/server/services/generation/generation.types';
import { generationPanel, generationStore } from '~/store/generation.store';
import { formatDateMin } from '~/utils/date-helpers';

// export function QueueItem({ data: request, index }: { data: Generation.Request; index: number }) {
export function QueueItem({ request }: Props) {
  const { classes, cx } = useStyle();

  const generationStatus = useGenerationStatus();
  const { unstableResources } = useUnstableResources();

  const { copied, copy } = useClipboard();

  const status = request.status ?? GenerationRequestStatus.Pending;
  const isDraft = request.sequential ?? false;
  const pendingProcessing = isDraft
    ? request.images?.every((x) => !x.status)
    : request.images?.some((x) => !x.status || x.status === 'Started');
  const failed = status === GenerationRequestStatus.Error;

  const deleteImageMutation = useDeleteGenerationRequestImages();
  const deleteMutation = useDeleteGenerationRequest();
  const cancellingDeleting = deleteImageMutation.isLoading || deleteMutation.isLoading;

  const handleDeleteQueueItem = () => {
    openConfirmModal({
      title: 'Delete Creation',
      children: `Are you sure you want to delete this creation?`,
      labels: { confirm: 'Delete', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      zIndex: constants.imageGeneration.drawerZIndex + 1,
      onConfirm: () => {
        deleteMutation.mutate({ id: request.id });
      },
    });
  };

  const handleCancel = () => {
    const ids =
      request.images
        ?.filter((x) => (isDraft ? !x.status : !x.status || x.status === 'Started'))
        .map((x) => x.id) ?? [];
    if (ids.length) {
      deleteImageMutation.mutate({
        ids,
        cancelled: true,
      });
    }
  };

  const handleCopy = () => {
    copy(request.images?.map((x) => x.hash).join('\n'));
  };

  const handleGenerate = () => {
    const { resources, params } = request;
    generationStore.setData({
      type: 'remix',
      data: { resources, params: { ...params, seed: undefined } },
    });
  };

  const { prompt, ...details } = request.params;
  const images = request.images
    ?.filter((x) => x.duration)
    .sort((a, b) => b.duration! - a.duration!);

  const hasUnstableResources = request.resources.some((x) => unstableResources.includes(x.id));
  const overwriteStatusLabel =
    hasUnstableResources && status === GenerationRequestStatus.Error
      ? `${status} - Potentially caused by unstable resources`
      : status === GenerationRequestStatus.Error
      ? `${status} - Generations can error for any number of reasons, try regenerating or swapping what models/additional resources you're using.`
      : status;

  // const boost = (request: Generation.Request) => {
  //   console.log('boost it', request);
  // };

  // TODO - enable this after boosting is ready
  // const handleBoostClick = () => {
  //   if (showBoost) openBoostModal({ request, cb: boost });
  //   else boost(request);
  // };

  const refundTime = useMemo(() => {
    return !failed ? undefined : dayjs(request.createdAt).add(1, 'minutes').toDate();
  }, [failed, request.createdAt]);

  const refunded = Math.ceil(
    !!request.cost
      ? (request.cost / request.quantity) * (request.quantity - (request.images?.length ?? 0))
      : 0
  );
  const cost = !!request.cost ? request.cost - refunded : 0;

  return (
    <Card withBorder px="xs">
      <Card.Section py={4} inheritPadding withBorder>
        <div className="flex justify-between">
          <div className="flex gap-1 items-center">
            <GenerationStatusBadge
              status={request.status}
              complete={request.images?.filter((x) => x.duration).length ?? 0}
              processing={request.images?.filter((x) => x.status === 'Started').length ?? 0}
              quantity={request.quantity}
              tooltipLabel={overwriteStatusLabel}
              progress
            />

            <Text size="xs" color="dimmed">
              {formatDateMin(request.createdAt)}
            </Text>
            {!!cost &&
              dayjs(request.createdAt).toDate() >=
                constants.buzz.generationBuzzChargingStartDate && (
                <CurrencyBadge unitAmount={cost} currency={Currency.BUZZ} size="xs" />
              )}
            <Tooltip {...tooltipProps} label="Copy Job IDs">
              <ActionIcon size="md" p={4} radius={0} onClick={handleCopy}>
                {copied ? <IconCheck /> : <IconInfoHexagon />}
              </ActionIcon>
            </Tooltip>
          </div>
          <div className="flex gap-1">
            {generationStatus.available && (
              <Tooltip {...tooltipProps} label="Remix">
                <ActionIcon size="md" p={4} radius={0} onClick={handleGenerate}>
                  <IconArrowsShuffle />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip
              {...tooltipProps}
              label={pendingProcessing ? 'Cancel request' : 'Delete creation'}
            >
              <ActionIcon
                size="md"
                onClick={pendingProcessing ? handleCancel : handleDeleteQueueItem}
                disabled={cancellingDeleting}
                color="red"
              >
                {pendingProcessing ? <IconX size={20} /> : <IconTrash size={20} />}
              </ActionIcon>
            </Tooltip>
          </div>
        </div>
      </Card.Section>
      <div className="flex flex-col gap-3 py-3 @container">
        {/* TODO.generation - add restart functionality to the code commented out below */}
        {/* {status !== GenerationRequestStatus.Cancelled && (
          <div
            className={cx(
              classes.stopped,
              'flex justify-between items-center rounded-3xl p-1 pl-2'
            )}
          >
            <Text
              color={theme.colorScheme === 'dark' ? 'yellow' : 'orange'}
              weight={500}
              className="flex items-center gap-1 "
            >
              <IconHandStop size={16} /> Stopped
            </Text>
            <Button compact color="gray" radius="xl">
              <span className="flex gap-1">
                <IconRotateClockwise size={16} />
                <span>Restart</span>
              </span>
            </Button>
          </div>
        )} */}
        {refundTime && refundTime > new Date() && (
          <Alert color="yellow" p={0}>
            <div className="flex items-center px-3 py-1 gap-1">
              <Text size="xs" color="yellow" lh={1}>
                <IconAlertTriangleFilled size={20} />
              </Text>
              <Text size="xs" lh={1.2} color="yellow">
                {`There was an error generating. You will be refunded for any undelivered images by ${formatDateMin(
                  refundTime
                )}.`}
              </Text>
            </div>
          </Alert>
        )}
        <ContentClamp maxHeight={36} labelSize="xs">
          <Text lh={1.3} sx={{ wordBreak: 'break-all' }}>
            {prompt}
          </Text>
        </ContentClamp>
        <Collection items={request.resources} limit={3} renderItem={ResourceBadge} grouped />
        {(!!images?.length || pendingProcessing) && (
          <div className={classes.grid}>
            {pendingProcessing && <GenerationPlaceholder request={request} />}
            {images?.map((image) => (
              <GeneratedImage key={image.id} image={image} request={request} />
            ))}
          </div>
        )}
      </div>
      <Card.Section
        withBorder
        sx={(theme) => ({
          marginLeft: -theme.spacing.xs,
          marginRight: -theme.spacing.xs,
        })}
      >
        <GenerationDetails
          label="Additional Details"
          params={details}
          labelWidth={150}
          paperProps={{ radius: 0, sx: { borderWidth: '1px 0 0 0' } }}
        />
      </Card.Section>
    </Card>
  );
}

type Props = {
  request: Generation.Request;
  // id: number;
};

const useStyle = createStyles((theme) => ({
  stopped: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[1],
  },
  grid: {
    display: 'grid',
    gap: theme.spacing.xs,
    gridTemplateColumns: 'repeat(2, 1fr)', // default for larger screens, max 6 columns

    // [`@media (max-width: ${theme.breakpoints.xl}px)`]: {
    //   gridTemplateColumns: 'repeat(4, 1fr)', // 4 columns for screens smaller than xl
    // },
    [`@container (min-width: 530px)`]: {
      gridTemplateColumns: 'repeat(3, 1fr)', // 3 columns for screens smaller than md
    },
    [`@container (min-width: 900px)`]: {
      gridTemplateColumns: 'repeat(4, 1fr)', // 5 columns for screens smaller than xl
    },
    [`@container (min-width: 1200px)`]: {
      gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))',
    },
  },
  asSidebar: {
    gridTemplateColumns: 'repeat(2, 1fr)',
  },
}));

const ResourceBadge = (props: Generation.Resource) => {
  const { unstableResources } = useUnstableResources();

  const { modelId, modelName, id, name } = props;
  const unstable = unstableResources?.includes(id);

  const badge = (
    <Badge
      size="sm"
      color={unstable ? 'yellow' : undefined}
      sx={{ maxWidth: 200, cursor: 'pointer' }}
      component={NextLink}
      href={`/models/${modelId}?modelVersionId=${id}`}
      onClick={() => generationPanel.close()}
    >
      {modelName} - {name}
    </Badge>
  );

  return unstable ? <Tooltip label="Unstable resource">{badge}</Tooltip> : badge;
};

const tooltipProps: Omit<TooltipProps, 'children' | 'label'> = {
  withinPortal: true,
  withArrow: true,
  color: 'dark',
  zIndex: constants.imageGeneration.drawerZIndex + 1,
};

const statusColors: Record<GenerationRequestStatus, MantineColor> = {
  [GenerationRequestStatus.Pending]: 'gray',
  [GenerationRequestStatus.Cancelled]: 'gray',
  [GenerationRequestStatus.Processing]: 'yellow',
  [GenerationRequestStatus.Succeeded]: 'green',
  [GenerationRequestStatus.Error]: 'red',
};
