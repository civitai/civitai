import { Box, Stack, StepProps, Stepper, Text, Title, createStyles } from '@mantine/core';
import { useRef, useState } from 'react';
import { OnboardingContentExperience } from '~/components/Onboarding/OnboardingContentExperience';
import { OnboardingBuzz } from '~/components/Onboarding/OnboardingBuzz';
import { OnboardingProfile } from '~/components/Onboarding/OnboardingProfile';
import { OnboardingTos } from '~/components/Onboarding/OnboardingTos';
import { OnboardingRedTos } from '~/components/Onboarding/OnboardingRedTos';
import { useGetRequiredOnboardingSteps } from '~/components/Onboarding/onboarding.utils';
import { OnboardingSteps } from '~/server/common/enums';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { LogoBadge } from '~/components/Logo/LogoBadge';
import { OnboardingProvider } from '~/components/Onboarding/OnboardingProvider';
import { ColorDomain } from '~/server/common/constants';
import { useDomainColor } from '~/hooks/useDomainColor';
import classes from './OnboardingWizard.module.scss';

type StepPropsCustom = Omit<StepProps, 'step'> & {
  step: number;
  Component: React.FC;
};

const steps: StepPropsCustom[] = [
  {
    step: OnboardingSteps.TOS,
    label: 'Terms',
    description: 'Review our terms',
    Component: OnboardingTos,
  },
  {
    step: OnboardingSteps.RedTOS,
    label: 'Terms',
    description: 'Review our terms',
    Component: OnboardingRedTos,
  },
  {
    step: OnboardingSteps.Profile,
    label: 'Account Details',
    description: 'Please verify your account details',
    Component: OnboardingProfile,
  },
  {
    step: OnboardingSteps.BrowsingLevels,
    label: 'Experience',
    description: 'Personalize your experience',
    Component: OnboardingContentExperience,
  },
  {
    step: OnboardingSteps.Buzz,
    label: 'Buzz',
    description: 'Power-up your experience',
    Component: OnboardingBuzz,
  },
];

export default function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
  const onboardingSteps = useGetRequiredOnboardingSteps();
  const onboardingStepsRef = useRef(onboardingSteps);
  const [active, setActive] = useState(0);
  const domain = useDomainColor();

  const next = () => {
    if (active < onboardingStepsRef.current.length - 1) setActive((x) => x + 1);
    else onComplete();
  };

  const availableSteps = steps.filter((item) => onboardingStepsRef.current.includes(item.step));
  const Component = availableSteps[active]?.Component;

  const isReturningUser =
    availableSteps.length === 1 && availableSteps[0].step === OnboardingSteps.BrowsingLevels;

  return (
    <div className="size-full overflow-y-auto">
      <div className="container my-3 flex max-w-md flex-col">
        {!isReturningUser && (
          <div className="mx-auto flex items-center gap-1">
            <Box w={86}>
              <LogoBadge />
            </Box>
            <Stack gap={0} mt={-5}>
              <Title sx={{ lineHeight: 1 }}>Welcome!</Title>
              <Text>{`Let's setup your account`}</Text>
            </Stack>
          </div>
        )}
        <OnboardingProvider next={next} isReturningUser={isReturningUser}>
          {availableSteps.length > 1 ? (
            <Stepper
              active={active}
              color="green"
              allowNextStepsSelect={false}
              classNames={classes}
            >
              {availableSteps.map(({ Component, ...item }, index) => (
                <Stepper.Step key={index} {...item} step={index}>
                  <Component />
                </Stepper.Step>
              ))}
            </Stepper>
          ) : (
            Component && <Component />
          )}
        </OnboardingProvider>
      </div>
    </div>
  );
}
