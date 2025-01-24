import { Button, CloseButton, Group, Paper, Text } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import React, { useCallback } from 'react';
import { TooltipRenderProps } from 'react-joyride';

export interface StepData {
  onNext?: (opts?: { isMobile?: boolean }) => Promise<void>;
  onPrev?: (opts?: { isMobile?: boolean }) => Promise<void>;
  waitForElement?: { selector: string; timeout?: number };
}

export function TourPopover(props: TooltipRenderProps) {
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
      backProps.onClick(e);
      await (step.data as StepData)?.onPrev?.({ isMobile: false });
    },
    [backProps, step.data]
  );

  const handleNextClick = useCallback<React.MouseEventHandler<HTMLButtonElement>>(
    async (e) => {
      primaryProps.onClick(e);
      await (step.data as StepData)?.onNext?.({ isMobile: false });
    },
    [primaryProps, step.data]
  );

  return (
    <Paper {...tooltipProps} className="flex flex-col gap-4" p="sm" radius="md" maw="375px">
      <Group position="apart" align="flex-start" noWrap>
        {step.title && (
          <Text size="lg" lineClamp={2}>
            {step.title}
          </Text>
        )}
        {!step.hideCloseButton && <CloseButton {...closeProps} ml="auto" />}
      </Group>
      <Text>{step.content}</Text>
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
                {isLastStep ? 'Done' : primaryProps.title}
              </Button>
            </Group>
          )}
        </Group>
      )}
    </Paper>
  );
}
