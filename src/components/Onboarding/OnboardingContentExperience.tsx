import { Button, Container, Group, Stack, Title } from '@mantine/core';
import { ContentControls } from '~/components/Account/ContentControls';
import { MatureContentSettings } from '~/components/Account/MatureContentSettings';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { useOnboardingContext } from '~/components/Onboarding/OnboardingProvider';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import { OnboardingSteps } from '~/server/common/enums';

export function OnboardingContentExperience() {
  const { next } = useOnboardingContext();
  const { mutate, isLoading } = useOnboardingStepCompleteMutation();

  const handleStepComplete = () => {
    mutate({ step: OnboardingSteps.BrowsingLevels }, { onSuccess: () => next() });
  };

  return (
    <Container size="xs" px={0}>
      <Stack gap="xl">
        <StepperTitle
          title="Content Experience"
          description="Personalize your AI content exploration! Fine-tune preferences for a delightful and safe browsing experience."
        />

        <Stack>
          <ContentControls />
          <Stack gap="xs" mt="sm">
            <Title order={3}>Content Moderation</Title>
            <MatureContentSettings />
          </Stack>
        </Stack>

        <Group justify="space-between">
          <OnboardingAbortButton size="lg">Sign Out</OnboardingAbortButton>
          <Button size="lg" onClick={handleStepComplete} loading={isLoading}>
            Save
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
