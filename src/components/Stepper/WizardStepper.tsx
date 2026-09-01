import type { StepperProps, StepperStylesNames } from '@mantine/core';
import { Stepper } from '@mantine/core';
import clsx from 'clsx';
import classes from './WizardStepper.module.scss';

type WizardStepperProps = Omit<StepperProps, 'classNames'> & {
  classNames?: Partial<Record<StepperStylesNames, string>>;
};

export function WizardStepper({ classNames, ...props }: WizardStepperProps) {
  return (
    <Stepper
      size="sm"
      allowNextStepsSelect={false}
      {...props}
      classNames={{
        ...classNames,
        steps: clsx(classes.steps, classNames?.steps),
        step: clsx(classes.step, classNames?.step),
        stepBody: clsx(classes.stepBody, classNames?.stepBody),
        separator: clsx(classes.separator, classNames?.separator),
      }}
    />
  );
}

WizardStepper.Step = Stepper.Step;
WizardStepper.Completed = Stepper.Completed;
