import {
  Button,
  Card,
  Container,
  Group,
  Stack,
  createStyles,
  Text,
  Switch,
  Box,
  BoxProps,
  Image,
  Title,
  Flex,
} from '@mantine/core';
import { IconEyeExclamation } from '@tabler/icons-react';
import { NewsletterToggle } from '~/components/Account/NewsletterToggle';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { useOnboardingContext } from '~/components/Onboarding/OnboardingProvider';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import { OnboardingSteps } from '~/server/common/enums';
import React, { forwardRef } from 'react';
import { useStyles } from './OnboardingContentExperience.module.scss';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconArrowRight } from '@tabler/icons-react';
import { useMediaQuery } from '@mantine/hooks';

// TODO.manuel - On merge of NSFW stuff, feel free to throw away everything I've done here...
export interface OnboardingContentExperienceProps extends BoxProps {
  newsletterCard?: boolean;
  newsletterBot?: boolean;
}

export const OnboardingContentExperience = forwardRef<
  HTMLDivElement,
  OnboardingContentExperienceProps
>((props, ref) => {
  const { newsletterCard, newsletterBot, className, ...others } = props;

  return (
    <Box
      className={`${newsletterCard ? useStyles().newsletterCard : ''} ${
        newsletterBot ? useStyles().newsletterBot : ''
      } ${className}`}
      {...others}
      ref={ref}
    />
  );
});

OnboardingContentExperience.displayName = 'OnboardingContentExperience';

export function OnboardingContentExperience() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const { classes } = useStyles();
  const { next, isReturningUser } = useOnboardingContext();
  const { mutate, isLoading } = useOnboardingStepCompleteMutation();

  const handleStepComplete = () => {
    mutate({ step: OnboardingSteps.BrowsingLevels }, { onSuccess: () => next() });
  };

  return (
    <Container size="xl" py={80}>
      <Stack spacing={80}>
        <Box>
          <Title order={2} ta="center" mb={40}>
            {t('onboarding.contentExperience.title')}
          </Title>
          <Flex gap={40} direction={isMobile ? 'column' : 'row'} align="stretch">
            <Card className={classes.newsletterCard} p={40} radius="lg" withBorder>
              <Stack spacing={24}>
                <Image
                  src="/images/onboarding/newsletter.png"
                  alt="Newsletter"
                  width={isMobile ? 280 : 360}
                  height={isMobile ? 280 : 360}
                  mx="auto"
                />
                <Stack spacing={16}>
                  <Title order={3} ta="center">
                    {t('onboarding.contentExperience.newsletter.title')}
                  </Title>
                  <Text size="lg" c="dimmed" ta="center">
                    {t('onboarding.contentExperience.newsletter.description')}
                  </Text>
                </Stack>
                <Button
                  variant="light"
                  size="lg"
                  rightSection={<IconArrowRight size={20} />}
                  onClick={() => navigate('/onboarding/newsletter')}
                >
                  {t('onboarding.contentExperience.newsletter.button')}
                </Button>
              </Stack>
            </Card>

            <Card className={classes.newsletterBot} p={40} radius="lg" withBorder>
              <Stack spacing={24}>
                <Image
                  src="/images/onboarding/newsletter-bot.png"
                  alt="Newsletter Bot"
                  width={isMobile ? 280 : 360}
                  height={isMobile ? 280 : 360}
                  mx="auto"
                />
                <Stack spacing={16}>
                  <Title order={3} ta="center">
                    {t('onboarding.contentExperience.newsletterBot.title')}
                  </Title>
                  <Text size="lg" c="dimmed" ta="center">
                    {t('onboarding.contentExperience.newsletterBot.description')}
                  </Text>
                </Stack>
                <Button
                  variant="light"
                  size="lg"
                  rightSection={<IconArrowRight size={20} />}
                  onClick={() => navigate('/onboarding/newsletter-bot')}
                >
                  {t('onboarding.contentExperience.newsletterBot.button')}
                </Button>
              </Stack>
            </Card>
          </Flex>
        </Box>

        <Stack>
          <Text>
            If you&apos;d like to modify your Civitai Content Experience, you can do so from your
            account settings after completing onboarding.
          </Text>
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
