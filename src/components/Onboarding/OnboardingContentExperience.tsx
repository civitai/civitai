import {
  Button,
  Card,
  Container,
  Group,
  Stack,
  createStyles,
  Text,
  Switch,
  Title,
} from '@mantine/core';
import { IconEyeExclamation } from '@tabler/icons-react';
import { ContentControls } from '~/components/Account/ContentControls';
import { MatureContentSettings } from '~/components/Account/MatureContentSettings';
import { NewsletterCallout } from '~/components/Account/NewsletterToggle';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { useOnboardingWizardContext } from '~/components/Onboarding/OnboardingWizard';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import { OnboardingSteps } from '~/server/common/enums';

export function OnboardingContentExperience() {
  const { next, isReturningUser } = useOnboardingWizardContext();
  const { mutate, isLoading } = useOnboardingStepCompleteMutation();

  const handleStepComplete = () => {
    mutate({ step: OnboardingSteps.BrowsingLevels }, { onSuccess: () => next() });
  };

  return (
    <Container size="xs" px={0}>
      <Stack spacing="xl">
        {!isReturningUser ? (
          <>
            <StepperTitle
              title="Content Experience"
              description="Personalize your AI content exploration! Fine-tune preferences for a delightful and safe browsing experience."
            />
            <NewsletterCallout />
          </>
        ) : (
          <StepperTitle
            title="Updated Content Experience"
            description={
              <Text>
                We have updated our rating system to simplify filtering content on the site. Going
                forward content on Civitai will be rated on a standard scale consistent with other
                media. This is a one-time process to set your basic filtering, but you can adjust it
                any time using the <IconEyeExclamation style={{ display: 'inline-block' }} /> icon
                in the top right.
              </Text>
            }
          />
        )}

        <Stack>
          <ContentControls />

          <Stack spacing="xs" mt="sm">
            <Title order={3}>Content Moderation</Title>
            <MatureContentSettings />
          </Stack>
        </Stack>

        <Group position="apart">
          <OnboardingAbortButton size="lg">Sign Out</OnboardingAbortButton>
          <Button size="lg" onClick={handleStepComplete} loading={isLoading}>
            Save
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
