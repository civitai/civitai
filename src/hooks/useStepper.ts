import type React from 'react';
import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

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
// export const useStepper = ({
//   defaultActive = 0,
//   steps: _steps,
//   onComplete = () => undefined,
// }: UseStepperProps) => {
//   const steps = _steps.filter((x) => !x.hidden);
//   const stepCount = steps.length;
//   const [active, setActive] = useState(defaultActive);
//   const { render, disableNext, ...step } = steps[active];

//   const next = () => {
//     if (!disableNext) setActive((current) => (current < stepCount - 1 ? current + 1 : current));
//   };

//   const previous = () => setActive((current) => (current > 0 ? current - 1 : current));

//   const goToStep = (step: number) => {
//     const target = steps[step];
//     if (target.disabled) {
//       console.error(`step ${active} is disabled`);
//       return;
//     }
//     // todo - check for disabled
//     setActive(step);
//   };

//   const reset = () => goToStep(0);

//   const lastActive = active === stepCount - 1;
//   const firstActive = active === 0;

//   return {
//     active,
//     next: lastActive ? onComplete : next,
//     previous,
//     goToStep,
//     reset,
//     lastActive,
//     firstActive,
//     stepCount,
//     component: render,
//     disableNext,
//     ...step,
//   };
// };

/** Represents the second element of the output of the `useStep` hook. */
type UseStepActions = {
  /** Go to the next step in the process. */
  goToNextStep: () => void;
  /** Go to the previous step in the process. */
  goToPrevStep: () => void;
  /** Reset the step to the initial step. */
  reset: () => void;
  /** Check if the next step is available. */
  canGoToNextStep: boolean;
  /** Check if the previous step is available. */
  canGoToPrevStep: boolean;
  /** Set the current step to a specific value. */
  setStep: Dispatch<SetStateAction<number>>;
};

type SetStepCallbackType = (step: number | ((step: number) => number)) => void;

/**
 * Custom hook that manages and navigates between steps in a multi-step process.
 * @param {number} maxStep - The maximum step in the process.
 * @returns {[number, UseStepActions]} An tuple containing the current step and helper functions for navigating steps.
 * @public
 * @see [Documentation](https://usehooks-ts.com/react-hook/use-step)
 * @example
 * ```tsx
 * const [currentStep, { goToNextStep, goToPrevStep, reset, canGoToNextStep, canGoToPrevStep, setStep }] = useStep(3);
 * // Access and use the current step and provided helper functions.
 * ```
 */
export function useStepper(maxStep: number): [number, UseStepActions] {
  const [currentStep, setCurrentStep] = useState(1);

  const canGoToNextStep = currentStep + 1 <= maxStep;
  const canGoToPrevStep = currentStep - 1 > 0;

  const setStep = useCallback<SetStepCallbackType>(
    (step) => {
      // Allow value to be a function so we have the same API as useState
      const newStep = step instanceof Function ? step(currentStep) : step;

      if (newStep >= 1 && newStep <= maxStep) {
        setCurrentStep(newStep);
        return;
      }

      throw new Error('Step not valid');
    },
    [maxStep, currentStep]
  );

  const goToNextStep = useCallback(() => {
    if (canGoToNextStep) {
      setCurrentStep((step) => step + 1);
    }
  }, [canGoToNextStep]);

  const goToPrevStep = useCallback(() => {
    if (canGoToPrevStep) {
      setCurrentStep((step) => step - 1);
    }
  }, [canGoToPrevStep]);

  const reset = useCallback(() => {
    setCurrentStep(1);
  }, []);

  return [
    currentStep,
    {
      goToNextStep,
      goToPrevStep,
      canGoToNextStep,
      canGoToPrevStep,
      setStep,
      reset,
    },
  ];
}
