import { Button, Card, Container, Group, Stack, Text, Switch } from '@mantine/core';
import { IconEyeExclamation } from '@tabler/icons-react';
import { NewsletterToggle } from '~/components/Account/NewsletterToggle';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { useOnboardingContext } from '~/components/Onboarding/OnboardingProvider';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import { OnboardingSteps } from '~/server/common/enums';
import classes from './OnboardingContentExperience.module.scss';

// TODO.manuel - On merge of NSFW stuff, feel free to throw away everything I've done here...
export function OnboardingContentExperience() {
  const { next, isReturningUser } = useOnboardingContext();
  const { mutate, isLoading } = useOnboardingStepCompleteMutation();

  const handleStepComplete = () => {
    mutate({ step: OnboardingSteps.BrowsingLevels }, { onSuccess: () => next() });
  };

  return (
    <Container size="xs" px={0}>
      <Stack gap="xl">
        {!isReturningUser ? (
          <>
            <StepperTitle
              title="Content Experience"
              description="Personalize your AI content exploration! Fine-tune preferences for a delightful and safe browsing experience."
            />
            <Card withBorder className={classes.newsletterCard}>
              <Card.Section withBorder inheritPadding py="xs">
                <Group justify="space-between">
                  <Text weight={500}>Send me the Civitai Newsletter!</Text>
                  <NewsletterToggle>
                    {({ subscribed, setSubscribed, isLoading: subscriptionLoading }) => (
                      <Switch
                        disabled={subscriptionLoading}
                        checked={subscribed}
                        onChange={({ target }) => setSubscribed(target.checked)}
                      />
                    )}
                  </NewsletterToggle>
                </Group>
              </Card.Section>

              <Text lh={1.3} mt="xs">
                Biweekly updates on industry news, new Civitai features, trending resources,
                community contests, and more!
              </Text>
              <img
                src="/images/newsletter-banner.png"
                alt="Robot holding a newspaper"
                className={classes.newsletterBot}
              />
            </Card>
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
          <Text>
            If you&apos;d like to modify your Civitai Content Experience, you can do so from your
            account settings after completing onboarding.
          </Text>
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
