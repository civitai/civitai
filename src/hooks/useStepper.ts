import React, { useCallback, useState } from 'react';

export type StepProps<T = any> = {
  render: React.FC<T>;
  props?: T;
  disableNext?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  label?: React.ReactNode;
};

export type UseStepperProps = {
  defaultActive?: number;
  steps: StepProps[];
  onComplete?: () => void;
};

/*
  Future developement ideas
  - manage state of multiple forms in stepper
*/

export type UseStepperReturn = ReturnType<typeof useStepper>;
export const useStepper = ({
  defaultActive = 0,
  steps: _steps,
  onComplete = () => undefined,
}: UseStepperProps) => {
  const steps = _steps.filter((x) => !x.hidden);
  const stepCount = steps.length;
  const [active, setActive] = useState(defaultActive);
  const { render, disableNext, ...step } = steps[active];

  const next = useCallback(() => {
    if (!disableNext) setActive((current) => (current < stepCount - 1 ? current + 1 : current));
  }, [disableNext, stepCount]);

  const previous = useCallback(
    () => setActive((current) => (current > 0 ? current - 1 : current)),
    []
  );

  const goToStep = (step: number) => {
    const target = steps[step];
    if (target.disabled) {
      console.error(`step ${active} is disabled`);
      return;
    }
    // todo - check for disabled
    setActive(step);
  };

  const reset = () => goToStep(0);

  const lastActive = active === stepCount - 1;
  const firstActive = active === 0;

  return {
    active,
    next: lastActive ? onComplete : next,
    previous,
    goToStep,
    reset,
    lastActive,
    firstActive,
    stepCount,
    component: render,
    disableNext,
    ...step,
  };
};
