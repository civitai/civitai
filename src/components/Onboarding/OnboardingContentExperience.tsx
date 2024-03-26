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
import { NewsletterToggle } from '~/components/Account/NewsletterToggle';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { useOnboardingWizardContext } from '~/components/Onboarding/OnboardingWizard';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import { OnboardingSteps } from '~/server/common/enums';

export function OnboardingContentExperience() {
  const { classes } = useStyles();
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
            <Card withBorder className={classes.newsletterCard}>
              <Card.Section withBorder inheritPadding py="xs">
                <Group position="apart">
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

const useStyles = createStyles((theme) => ({
  newsletterCard: {
    position: 'relative',
    overflow: 'visible',
    borderColor: theme.colors.blue[5],
    marginTop: 60,
    [theme.fn.largerThan('sm')]: {
      marginTop: 70,
    },

    '&::before': {
      content: '""',
      position: 'absolute',
      left: '-3px',
      top: '-3px',
      background: theme.fn.linearGradient(
        10,
        theme.colors.blue[9],
        theme.colors.blue[7],
        theme.colors.blue[5],
        theme.colors.cyan[9],
        theme.colors.cyan[7],
        theme.colors.cyan[5]
      ),
      backgroundSize: '200%',
      borderRadius: theme.radius.sm,
      width: 'calc(100% + 6px)',
      height: 'calc(100% + 6px)',
      filter: 'blur(4px)',
      zIndex: -1,
      animation: 'glowing 20s linear infinite',
      transition: 'opacity .3s ease-in-out',
    },
  },
  newsletterBot: {
    objectPosition: 'top',
    objectFit: 'cover',
    position: 'absolute',
    top: -100,
    right: 0,
    width: 200,
    zIndex: -1,
  },
}));
