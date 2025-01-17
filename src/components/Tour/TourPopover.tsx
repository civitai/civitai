import { Button, CloseButton, Group, Paper, Text } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import React, { useCallback } from 'react';
import { StoreHelpers, TooltipRenderProps } from 'react-joyride';
import { useTourContext } from '~/providers/TourProvider';

export interface StepData {
  onNext?: (helpers: StoreHelpers) => void | Promise<void>;
  onPrev?: (helpers: StoreHelpers) => void | Promise<void>;
}

export function TourPopover(props: TooltipRenderProps) {
  const { helpers } = useTourContext();
  const {
    index,
    step,
    continuous,
    isLastStep,
    backProps,
    closeProps,
    primaryProps,
    skipProps,
    tooltipProps,
  } = props;

  const handlePrevClick = useCallback<React.MouseEventHandler<HTMLButtonElement>>(
    async (e) => {
      if (helpers) await (step.data as StepData)?.onPrev?.(helpers);
      backProps.onClick(e);
    },
    [backProps, helpers, step.data]
  );

  const handleNextClick = useCallback<React.MouseEventHandler<HTMLButtonElement>>(
    async (e) => {
      if (helpers) await (step.data as StepData)?.onNext?.(helpers);
      primaryProps.onClick(e);
    },
    [helpers, primaryProps, step.data]
  );

  return (
    <Paper {...tooltipProps} className="flex flex-col gap-4" p="sm" radius="md" maw="400px">
      <Group position="apart" align="flex-start" noWrap>
        {step.title && (
          <Text size="lg" lineClamp={2}>
            {step.title}
          </Text>
        )}
        <CloseButton {...closeProps} ml="auto" />
      </Group>
      <Text>{step.content}</Text>
      <Group position="apart" noWrap>
        <Button {...skipProps} variant="subtle" size="xs" color="gray">
          {skipProps.title}
        </Button>
        {continuous && (
          <Group spacing={8} noWrap>
            {index > 0 && (
              <Button
                {...backProps}
                onClick={handlePrevClick}
                variant="subtle"
                size="xs"
                leftIcon={<IconChevronLeft size={16} />}
              >
                {backProps.title ?? 'Back'}
              </Button>
            )}
            <Button
              {...primaryProps}
              onClick={handleNextClick}
              size="xs"
              rightIcon={!isLastStep ? <IconChevronRight size={16} /> : null}
            >
              {primaryProps.title}
            </Button>
          </Group>
        )}
      </Group>
    </Paper>
  );
}
