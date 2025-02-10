import { Badge, Text, Button, createStyles, Progress, Card, Popover } from '@mantine/core';
import { GenerationStatusBadge } from '~/components/ImageGeneration/GenerationStatusBadge';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { IconHandStop } from '@tabler/icons-react';
import { generationStatusColors } from '~/shared/constants/generation.constants';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { generationPanel } from '~/store/generation.store';
import { useRouter } from 'next/router';
import { WorkflowStatus } from '@civitai/client';
import React from 'react';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { abbreviateNumber } from '~/utils/number-helpers';

export function QueueSnackbar() {
  const router = useRouter();
  const { classes, cx, theme } = useStyles();
  const {
    queued,
    queueStatus,
    requestLimit,
    requestsRemaining,
    userTier,
    latestImage,
    requestsLoading,
  } = useGenerationContext((state) => state);
  const slots = Array(requestLimit).fill(0);
  const includeQueueLink = !router.pathname.includes('/generate');

  const { balance } = useBuzz(undefined, 'generation');

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
            variant="link"
            className="cursor-pointer"
            onClick={() => generationPanel.setView('queue')}
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
        p={0}
        className={cx(classes.card, 'flex justify-center px-1 gap-2 items-stretch ')}
      >
        <div className="flex basis-20 items-center py-2 pl-1">
          {queueStatus ? (
            <GenerationStatusBadge
              status={queueStatus}
              complete={complete}
              processing={processing}
              quantity={quantity}
            />
          ) : balance ? (
            // <Tooltip
            //   label={
            //     <Text weight={600}>
            //       Generation Buzz Credit{' '}
            //       <Text color="blue.4" span>
            //         <div className="flex flex-row flex-nowrap items-center justify-center gap-1">
            //           <CurrencyIcon
            //             currency="BUZZ"
            //             size={16}
            //             color="currentColor"
            //             fill="currentColor"
            //           />
            //           {balanceLoading ? '...' : balance.toLocaleString()}
            //         </div>
            //       </Text>
            //     </Text>
            //   }
            //   refProp="innerRef"
            //   withinPortal
            // >
            <Popover withinPortal withArrow>
              <Popover.Target>
                <CurrencyBadge
                  currency="BUZZ"
                  size="sm"
                  unitAmount={balance}
                  displayCurrency={false}
                  formatter={abbreviateNumber}
                  textColor={theme.colors.blue[4]}
                  className="cursor-pointer"
                />
              </Popover.Target>
              <Popover.Dropdown>
                <div className="flex flex-col items-center">
                  <Text weight={600}>
                    Generation Buzz Credit{' '}
                    {/* <Text color="blue.4" span>
                    <div className="flex flex-row flex-nowrap items-center justify-center gap-1">
                      <CurrencyIcon
                        currency="BUZZ"
                        size={16}
                        color="currentColor"
                        fill="currentColor"
                      />
                      {balanceLoading ? '...' : balance.toLocaleString()}
                    </div>
                  </Text> */}
                  </Text>
                  <Text component={Link} variant="link" href="/articles/7012" target="_blank">
                    Learn more
                  </Text>
                </div>
              </Popover.Dropdown>
            </Popover>
          ) : // </Tooltip>
          null}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-1 py-2">
          <Text weight={500} className="flex items-center gap-1 text-sm">
            {!!queued.length && queueStatus ? (
              dictionary[queueStatus]()
            ) : includeQueueLink ? (
              <Text
                variant="link"
                className="cursor-pointer"
                onClick={() => generationPanel.setView('queue')}
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
              const colors = theme.fn.variant({
                color: item ? generationStatusColors[item.status] : 'gray',
                variant: 'light',
              });
              const quantity = item ? item.quantity : 0;
              const complete = quantity ? item.complete / quantity : 0;
              const processing = quantity ? item.processing / quantity : 0;
              return (
                <Progress
                  key={i}
                  color={item ? generationStatusColors[item.status] : 'gray'}
                  radius="xl"
                  sections={[
                    { value: complete * 100, color: 'green' },
                    { value: processing * 100, color: 'yellow' },
                  ]}
                  h={6}
                  w="100%"
                  maw={32}
                  style={{ backgroundColor: item ? colors.background : undefined }}
                  className="flex-1"
                  styles={{
                    bar: {
                      transition: 'width 200ms, left 200ms',
                    },
                  }}
                />
              );
            })}
          </div>
        </div>
        <div className="flex basis-20 items-center justify-end py-1">
          {latestImage && latestImage.status === 'succeeded' && (
            <Card
              withBorder
              radius="md"
              p={0}
              style={{
                height: 42,
              }}
            >
              {/* eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element */}
              <img alt="" src={latestImage.url} className="max-h-full" />
            </Card>
          )}
        </div>
      </Card>
      {requestsRemaining <= 0 && userTier === 'free' && (
        <Badge color="yellow" h={'auto'} w="100%" p={0} radius="xl" classNames={classes}>
          <div className="flex w-full flex-wrap items-center justify-between gap-2 p-0.5">
            <Text>
              <div className="flex items-center gap-1 pl-1">
                <IconHandStop size={16} />
                You can queue {requestLimit} jobs at once
              </div>
            </Text>
            <Button compact color="dark" radius="xl" component={Link} href="/pricing">
              <Text color="yellow">Increase</Text>
            </Button>
          </div>
        </Badge>
      )}
    </div>
  );
}

const useStyles = createStyles((theme) => ({
  card: {
    boxShadow: `inset 0 2px ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
    }`,

    // '&:hover': {
    //   backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[0],
    // },
  },
  inner: { width: '100%' },
}));
