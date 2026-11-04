import {
  Badge,
  Text,
  Button,
  Progress,
  useMantineTheme,
  defaultVariantColorsResolver,
} from '@mantine/core';
import { GenerationStatusBadge } from '~/components/ImageGeneration/GenerationStatusBadge';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { IconHandStop } from '@tabler/icons-react';
import { generationStatusColors } from '~/shared/constants/generation.constants';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useRouter } from 'next/router';
import type { WorkflowStatus } from '@civitai/orchestration-client';
import React from 'react';
import classes from './QueueSnackbar.module.scss';
import clsx from 'clsx';

export function QueueSnackbar() {
  const router = useRouter();
  const { queued, queueStatus, requestLimit, requestsRemaining, requestsLoading } =
    useGenerationContext((state) => state);
  const includeQueueLink = !router.pathname.includes('/generate');

  const { complete, processing, quantity } = queued.reduce(
    (acc, request) => {
      acc.complete += request.complete;
      acc.processing += request.processing;
      acc.quantity += request.quantity;
      return acc;
    },
    { complete: 0, processing: 0, quantity: 0 }
  );

  if (requestsLoading) return null;

  const dictionary: Record<WorkflowStatus, () => React.ReactNode> = {
    unassigned: renderQueuePendingProcessing,
    preparing: renderQueuePendingProcessing,
    scheduled: renderQueuePendingProcessing,
    processing: renderQueuePendingProcessing,
    succeeded: () => 'All jobs complete',
    failed: () => 'All jobs complete',
    expired: () => 'All jobs expired',
    canceled: () => 'All jobs cancelled',
  };

  function renderQueuePendingProcessing() {
    return (
      <>
        <span>{`${queued.length} job${queued.length > 1 ? 's' : ''} in `}</span>
        {includeQueueLink ? (
          <Text
            component="span"
            inline
            c="blue.4"
            className="cursor-pointer"
            onClick={() => generationGraphPanel.setView('queue')}
          >
            queue
          </Text>
        ) : (
          <span>queue</span>
        )}
      </>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <div className={'flex items-center gap-2 rounded-md'}>
        {/* Left: queue status badge + slot indicators */}
        <div className="flex flex-1 items-center gap-2">
          {queueStatus && (
            <GenerationStatusBadge
              status={queueStatus}
              complete={complete}
              processing={processing}
              quantity={quantity}
            />
          )}
          <QueueSlots />
          <Text size="xs" c="dimmed">
            {!!queued.length && queueStatus ? (
              dictionary[queueStatus]()
            ) : includeQueueLink ? (
              <Text
                component="span"
                c="blue.4"
                size="xs"
                className="cursor-pointer"
                onClick={() => generationGraphPanel.setView('queue')}
              >
                View queue
              </Text>
            ) : (
              `${requestsRemaining}/${requestLimit} slots`
            )}
          </Text>
        </div>
      </div>

      <QueueLimitBanner />
    </div>
  );
}

/**
 * One bar per queue slot, filled by its job's progress. `fill` spreads the bars across the full
 * width, so any number of slots fits one line.
 */
export function QueueSlots({ fill, className }: { fill?: boolean; className?: string }) {
  const theme = useMantineTheme();
  const { queued, requestLimit } = useGenerationContext((state) => state);
  const slots = Array(requestLimit).fill(0);

  return (
    <div className={clsx('flex items-center gap-1', className)}>
      {slots.map((_, i) => {
        const item = queued[i];
        const colors = defaultVariantColorsResolver({
          color: item ? generationStatusColors[item.status] : 'gray',
          variant: 'light',
          theme,
        });
        const itemQuantity = item ? item.quantity : 0;
        const itemComplete = itemQuantity ? item.complete / itemQuantity : 0;
        const itemProcessing = itemQuantity ? item.processing / itemQuantity : 0;
        return (
          <Progress.Root
            key={i}
            data-slot={item ? item.status : 'empty'}
            color={item ? generationStatusColors[item.status] : 'gray'}
            radius="xl"
            h={fill ? 4 : 6}
            w={fill ? undefined : 12}
            className={fill ? 'flex-1' : undefined}
            style={{ backgroundColor: item ? colors.background : undefined }}
            transitionDuration={200}
          >
            {[
              { value: itemComplete * 100, color: 'green' },
              { value: itemProcessing * 100, color: 'yellow' },
            ].map((section, index) => (
              <Progress.Section key={index} animated value={section.value} color={section.color} />
            ))}
          </Progress.Root>
        );
      })}
    </div>
  );
}

/** A free member's full queue, with the way to a bigger one. */
export function QueueLimitBanner() {
  const { requestLimit, requestsRemaining, userTier, requestsLoading } = useGenerationContext(
    (state) => state
  );
  if (requestsLoading || requestsRemaining > 0 || userTier !== 'free') return null;

  return (
    <Badge color="yellow" h={'auto'} w="100%" p={0} radius="xl" classNames={classes}>
      <div className="flex w-full flex-wrap items-center justify-between gap-2 p-0.5">
        <Text component="div">
          <div className="flex items-center gap-1 pl-1">
            <IconHandStop size={16} />
            You can queue {requestLimit} jobs at once
          </div>
        </Text>
        <Button size="compact-sm" color="dark" radius="xl" component={Link} href="/pricing">
          <Text c="yellow">Increase</Text>
        </Button>
      </div>
    </Badge>
  );
}
