import type { StepperProps, StepperStylesNames } from '@mantine/core';
import { Stepper } from '@mantine/core';
import clsx from 'clsx';
import { forwardRef } from 'react';
import type { breakpoints } from '~/utils/tailwind';
import classes from './WizardStepper.module.scss';

type Breakpoint = keyof typeof breakpoints;

// Written out rather than built from the breakpoint name, so Tailwind's scanner sees them.
const hideLabelsClasses: Record<Breakpoint, string> = {
  xs: 'max-xs:hidden',
  sm: 'max-sm:hidden',
  md: 'max-md:hidden',
  lg: 'max-lg:hidden',
  xl: 'max-xl:hidden',
};

export type WizardStepperProps = Omit<StepperProps, 'classNames'> & {
  classNames?: Partial<Record<StepperStylesNames, string>>;
  /** `inline` leaves the label beside the circle, the way Mantine lays it out. */
  labelPosition?: 'bottom' | 'inline';
  /** `false` keeps the labels at every width. */
  hideLabelsBelow?: Breakpoint | false;
};

const WizardStepperBase = forwardRef<HTMLDivElement, WizardStepperProps>(function WizardStepper(
  { classNames, labelPosition = 'bottom', hideLabelsBelow = 'sm', ...props },
  ref
) {
  const below = labelPosition === 'bottom';

  return (
    <Stepper
      ref={ref}
      size="sm"
      allowNextStepsSelect={false}
      {...props}
      classNames={{
        ...classNames,
        steps: clsx(below && classes.steps, classNames?.steps),
        step: clsx(below && classes.step, classNames?.step),
        stepBody: clsx(
          below && classes.stepBody,
          hideLabelsBelow && hideLabelsClasses[hideLabelsBelow],
          classNames?.stepBody
        ),
        separator: clsx(below && classes.separator, classNames?.separator),
      }}
    />
  );
});

export const WizardStepper = Object.assign(WizardStepperBase, {
  Step: Stepper.Step,
  Completed: Stepper.Completed,
});
