import { Button, CloseButton, Group, Paper, Text } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import React, { useCallback, useLayoutEffect } from 'react';
import { TooltipRenderProps } from 'react-joyride';

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

  // const handlePrevClick = useCallback<React.MouseEventHandler<HTMLButtonElement>>(
  //   async (e) => {
  //     backProps.onClick(e);
  //     // await (step.data as StepData)?.onPrev?.();
  //   },
  //   [backProps, step.data]
  // );

  // const handleNextClick = useCallback<React.MouseEventHandler<HTMLButtonElement>>(
  //   async (e) => {
  //     primaryProps.onClick(e);
  //     // await (step.data as StepData)?.onNext?.();
  //   },
  //   [primaryProps, step.data]
  // );

  // useLayoutEffect(() => {
  //   console.log('dispatching resize event');
  //   window.dispatchEvent(new Event('resize'));
  // }, []);

  return (
    <Paper {...tooltipProps} className="ml-auto flex flex-col gap-4" p="sm" radius="md" maw="375px">
      <Group position="apart" noWrap>
        <Text size="sm" color="dimmed">
          {index + 1} of {size}
        </Text>
        {!step.hideCloseButton && <CloseButton {...closeProps} ml="auto" />}
      </Group>
      <div className="flex flex-col gap-1">
        {step.title && (
          <Text size="lg" weight={600} lineClamp={2}>
            {step.title}
          </Text>
        )}
        {typeof step.content === 'string' ? <Text>{step.content}</Text> : step.content}
      </div>
      {!step.hideFooter && (
        <Group position="apart" noWrap>
          {step.showSkipButton !== false && (
            <Button {...skipProps} variant="subtle" size="xs" color="gray">
              {skipProps.title}
            </Button>
          )}
          {continuous && (
            <Group spacing={8} noWrap>
              {index > 0 && !step.hideBackButton && (
                <Button
                  {...backProps}
                  variant="subtle"
                  size="xs"
                  leftIcon={<IconChevronLeft size={16} />}
                >
                  {backProps.title ?? 'Back'}
                </Button>
              )}
              <Button
                {...primaryProps}
                size="xs"
                rightIcon={!isLastStep ? <IconChevronRight size={16} /> : null}
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
