import { Button } from '@mantine/core';
import React, { createContext, useContext } from 'react';
import { UseStepperProps, UseStepperReturn, useStepper } from '~/hooks/useStepper';

const StepperContext = createContext<UseStepperReturn | null>(null);
export const useStepperContext = () => {
  const context = useContext(StepperContext);
  if (!context) throw new Error('missing stepper context');
  return context;
};

export function Stepper({ stepper }: { stepper: UseStepperReturn }) {
  const Component = stepper.component;

  return (
    <StepperContext.Provider value={stepper}>
      <Component {...stepper.props} />
    </StepperContext.Provider>
  );
}

function NextButton({
  disabled,
  onClick,
  ...btnProps
}: React.ComponentProps<typeof Button<'button'>>) {
  const { next, disableNext } = useStepperContext();
  return <Button disabled={disableNext || disabled} onClick={onClick ?? next} {...btnProps} />;
}

function PreviousButton({ onClick, ...btnProps }: React.ComponentProps<typeof Button<'button'>>) {
  const { previous, firstActive } = useStepperContext();
  if (firstActive) return null;
  return <Button onClick={onClick ?? previous} variant="default" {...btnProps} />;
}

Stepper.NextButton = NextButton;
Stepper.PreviousButton = PreviousButton;
