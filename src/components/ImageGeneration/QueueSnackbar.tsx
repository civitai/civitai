import {
  Badge,
  Text,
  Button,
  Progress,
  Card,
  Popover,
  useMantineTheme,
  defaultVariantColorsResolver,
  Anchor,
} from '@mantine/core';
import { GenerationStatusBadge } from '~/components/ImageGeneration/GenerationStatusBadge';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { IconHandStop } from '@tabler/icons-react';
import { generationStatusColors } from '~/shared/constants/generation.constants';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useRouter } from 'next/router';
import type { WorkflowStatus } from '@civitai/client';
import React from 'react';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { abbreviateNumber } from '~/utils/number-helpers';
import classes from './QueueSnackbar.module.scss';
import clsx from 'clsx';

export function QueueSnackbar() {
  const router = useRouter();
  const theme = useMantineTheme();
  const { queued, queueStatus, requestLimit, requestsRemaining, userTier, requestsLoading } =
    useGenerationContext((state) => state);
  const slots = Array(requestLimit).fill(0);
  const includeQueueLink = !router.pathname.includes('/generate');

  const {
    data: { accounts },
  } = useQueryBuzz(['blue']);
  const blueAccount = accounts.find((a) => a.type === 'blue');

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
    <div className="flex w-full flex-col gap-2 ">
      <Card
        radius="md"
        px={4}
        py={0}
        className={clsx(classes.card, 'flex flex-row items-stretch justify-center gap-2')}
      >
        <div className="flex basis-20 items-center py-2 pl-1">
          {queueStatus ? (
            <GenerationStatusBadge
              status={queueStatus}
              complete={complete}
              processing={processing}
              quantity={quantity}
            />
          ) : blueAccount?.balance ? (
            <Popover withinPortal withArrow>
              <Popover.Target>
                <CurrencyBadge
                  currency="BUZZ"
                  size="sm"
                  unitAmount={blueAccount?.balance ?? 0}
                  displayCurrency={false}
                  formatter={abbreviateNumber}
                  textColor={theme.colors.blue[4]}
                  className="cursor-pointer"
                />
              </Popover.Target>
              <Popover.Dropdown>
                <div className="flex flex-col items-center">
                  <Text fw={600}>Generation Buzz Credit</Text>
                  <Anchor component={Link} href="/articles/7012" target="_blank">
                    Learn more
                  </Anchor>
                </div>
              </Popover.Dropdown>
            </Popover>
          ) : null}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-1 py-2">
          <Text fw={500} component="div" className="flex items-center gap-1 text-sm">
            {!!queued.length && queueStatus ? (
              dictionary[queueStatus]()
            ) : includeQueueLink ? (
              <Text
                c="blue.4"
                size="sm"
                className="cursor-pointer"
                onClick={() => generationGraphPanel.setView('queue')}
              >
                View generation queue
              </Text>
            ) : (
              `${requestsRemaining} jobs available`
            )}
          </Text>
          <div className="flex w-full justify-center gap-2">
            {slots.map((slot, i) => {
              const item = queued[i];
              const colors = defaultVariantColorsResolver({
                color: item ? generationStatusColors[item.status] : 'gray',
                variant: 'light',
                theme,
              });
              const quantity = item ? item.quantity : 0;
              const complete = quantity ? item.complete / quantity : 0;
              const processing = quantity ? item.processing / quantity : 0;
              return (
                <Progress.Root
                  key={i}
                  color={item ? generationStatusColors[item.status] : 'gray'}
                  radius="xl"
                  h={6}
                  w="100%"
                  maw={32}
                  style={{ backgroundColor: item ? colors.background : undefined }}
                  className="flex-1"
                  transitionDuration={200}
                >
                  {[
                    { value: complete * 100, color: 'green' },
                    { value: processing * 100, color: 'yellow' },
                  ].map((section, index) => (
                    <Progress.Section
                      key={index}
                      animated
                      value={section.value}
                      color={section.color}
                    />
                  ))}
                </Progress.Root>
              );
            })}
          </div>
        </div>
        <div className="flex basis-20 items-center justify-end py-1"></div>
      </Card>
      {requestsRemaining <= 0 && userTier === 'free' && (
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
      )}
    </div>
  );
}
