import { Button, CloseButton, Group, Paper, Text } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { clsx } from 'clsx';
import React from 'react';
import type { TooltipRenderProps } from 'react-joyride';

export function TourPopover(props: TooltipRenderProps) {
  const {
    index,
    step,
    size,
    continuous,
    isLastStep,
    backProps,
    closeProps,
    primaryProps,
    skipProps,
    tooltipProps,
  } = props;

  const centered = step.placement === 'center';

  return (
    <Paper
      {...tooltipProps}
      className={clsx('flex flex-col gap-4 bg-white dark:bg-dark-6', centered && 'mx-auto')}
      p="sm"
      radius="md"
      maw="375px"
    >
      <Group justify="space-between" wrap="nowrap">
        <Text className={clsx(step.showProgress && 'hidden')} size="lg" fw={600} lineClamp={2}>
          {step.title}
        </Text>
        <Text className={clsx(!step.showProgress && 'hidden')} size="sm" c="dimmed">
          {index + 1} of {size}
        </Text>
        {!step.hideCloseButton && <CloseButton ml="auto" />}
      </Group>
      <div className="flex flex-col gap-1">
        {step.title && step.showProgress && (
          <Text size="lg" fw={600} lineClamp={2}>
            {step.title}
          </Text>
        )}
        {typeof step.content === 'string' ? <Text>{step.content}</Text> : step.content}
      </div>
      {!step.hideFooter && (
        <Group justify="space-between" wrap="nowrap">
          {step.showSkipButton !== false && (
            <Button {...skipProps} variant="subtle" size="xs" color="gray">
              {skipProps.title}
            </Button>
          )}
          {continuous && (
            <Group gap={8} wrap="nowrap">
              {index > 0 && !step.hideBackButton && (
                <Button
                  {...backProps}
                  variant="subtle"
                  size="xs"
                  leftSection={<IconChevronLeft size={16} />}
                >
                  {backProps.title ?? 'Back'}
                </Button>
              )}
              <Button
                {...primaryProps}
                size="xs"
                rightSection={!isLastStep ? <IconChevronRight size={16} /> : null}
              >
                {isLastStep ? 'Done' : primaryProps.title}
              </Button>
            </Group>
          )}
        </Group>
      )}
    </Paper>
  );
}
