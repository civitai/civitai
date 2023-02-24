import { Container, Stack, Stepper, Title } from '@mantine/core';
import React, { createContext, useContext, useState } from 'react';

type ContextState = { currentStep: number; goNext: () => void; goBack: () => void };
const WizardContext = createContext<ContextState>({
  currentStep: 0,
  goNext: () => ({}),
  goBack: () => ({}),
});

export const Wizard = ({ children }: { children: React.ReactNode }) => {
  const [currentStep, setCurrentStep] = useState(0);

  const goNext = () => setCurrentStep((prevStep) => prevStep + 1);
  const goBack = () => setCurrentStep((prevStep) => prevStep - 1);

  return (
    <WizardContext.Provider value={{ currentStep, goNext, goBack }}>
      <Stepper
        active={currentStep}
        onStepClick={setCurrentStep}
        size="xs"
        breakpoint="sm"
        allowNextStepsSelect
      >
        {children}
      </Stepper>
    </WizardContext.Provider>
  );
};

export const useWizardContext = () => {
  const context = useContext(WizardContext);
  if (!context) throw new Error('useWizardContext must be used within a WizardProvider');

  return context;
};

export const WizardSteps = ({ children }: { children: React.ReactElement<StepProps>[] }) => {
  const { currentStep } = useWizardContext();

  return <Container size="xl">{children[currentStep]}</Container>;
};

type StepProps = { children: React.ReactNode; title: string };
export const WizardStep = ({ children, title }: StepProps) => {
  return (
    <Stack p="lg">
      <Title order={2}>{title}</Title>
      {children}
    </Stack>
  );
};
