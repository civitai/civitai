import {
  Button,
  Stack,
  Text,
  Group,
  Container,
  Paper,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { useState } from 'react';

import { Currency } from '~/shared/utils/prisma/enums';
import { EarningBuzz, SpendingBuzz } from '../Buzz/FeatureCards/FeatureCards';
import { CurrencyBadge } from '../Currency/CurrencyBadge';
import { CurrencyIcon } from '../Currency/CurrencyIcon';
import { useBuzzCurrencyConfig } from '../Currency/useCurrencyConfig';
import { useDomainColor } from '~/hooks/useDomainColor';
import { getUserBuzzBonusAmount } from '~/server/common/user-helpers';
import { OnboardingSteps } from '~/server/common/enums';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { useOnboardingContext } from '~/components/Onboarding/OnboardingProvider';
import type { CaptchaState } from '~/components/TurnstileWidget/TurnstileWidget';
import {
  TurnstilePrivacyNotice,
  TurnstileWidget,
} from '~/components/TurnstileWidget/TurnstileWidget';
import { showErrorNotification } from '~/utils/notifications';
import { env } from '~/env/client';

export function OnboardingBuzz() {
  const { next } = useOnboardingContext();
  const theme = useMantineTheme();
  const domainColor = useDomainColor();
  const isGreen = domainColor === 'green';
  const paidAccountType = isGreen ? 'green' : 'yellow';
  const blueConfig = useBuzzCurrencyConfig('blue');
  const paidConfig = useBuzzCurrencyConfig(paidAccountType);
  const paidLabel = isGreen ? 'Green' : 'Yellow';
  const [captchaState, setCaptchaState] = useState<CaptchaState>({
    status: null,
    token: null,
    error: null,
  });

  const { mutate, isLoading } = useOnboardingStepCompleteMutation();
  const handleStepComplete = () => {
    if (captchaState.status !== 'success')
      return showErrorNotification({
        title: 'Cannot save',
        error: new Error(captchaState.error ?? 'Captcha token expired. Please try again.'),
      });

    if (!captchaState.token)
      return showErrorNotification({
        title: 'Cannot save',
        error: new Error('Captcha token is missing'),
      });

    mutate(
      {
        step: OnboardingSteps.Buzz,
        recaptchaToken: captchaState.token,
      },
      { onSuccess: () => next() }
    );
  };

  const blueRewardExamples = [
    'React to content',
    'First post of the day',
    'Get reactions',
    'Follow 3 new creators',
    'and more',
  ];

  return (
    <Container size="sm" px={0}>
      <Stack>
        <Stack gap={4}>
          <Title order={2} className="leading-[1.1]">
            What&rsquo;s Buzz about?
          </Title>
          <Text>
            Buzz is Civitai&rsquo;s creative currency. Use it to generate images and videos, train
            models, tip creators, unlock badges, and more. Some Buzz is earned; some is purchased.
            Here&rsquo;s how it breaks down.
          </Text>
        </Stack>
        <Stack gap="xl">
          <SpendingBuzz asList accountType={paidAccountType} />
          <Stack gap="sm">
            <Title order={3}>Types of Buzz</Title>
            <Stack gap="xs">
              <Paper withBorder p="md" radius="md">
                <Group gap="xs" mb={4} align="center">
                  <CurrencyIcon currency="BUZZ" type={paidAccountType} size={20} />
                  <Text fw={600} style={{ color: paidConfig.color }}>
                    {paidLabel} Buzz
                  </Text>
                </Group>
                <Text size="sm">
                  {isGreen
                    ? 'Use Green Buzz to pay for early access to AI models from your favorite creators and tip those who make content you love.'
                    : 'Use Yellow Buzz to generate mature content, pay for early access to AI models from your favorite creators, and tip those who make awesome content.'}
                </Text>
                <Text size="sm" fw={500} mt="sm">
                  Ways to get {paidLabel} Buzz
                </Text>
                <EarningBuzz asList accountType={paidAccountType} hideHeader />
              </Paper>
              <Paper withBorder p="md" radius="md">
                <Group gap="xs" mb={4} align="center">
                  <CurrencyIcon currency="BUZZ" type="blue" size={20} />
                  <Text fw={600} style={{ color: blueConfig.color }}>
                    Blue Buzz
                  </Text>
                </Group>
                <Text size="sm">
                  <Text span fw={700}>
                    Not looking to purchase right now?
                  </Text>{' '}
                  Get rewarded for engaging with the community.
                </Text>
                <Text size="sm" fw={500} mt="sm">
                  Ways to earn Blue Buzz
                </Text>
                <Text size="sm" c="dimmed">
                  {blueRewardExamples.join(' · ')}
                </Text>
                <Text size="xs" c="dimmed" mt={4}>
                  Visit your Buzz Dashboard to learn more.
                </Text>
              </Paper>
            </Stack>
          </Stack>
          <StepperTitle
            title="Getting Started"
            description={
              <Text>
                To get you started, we will grant you{' '}
                <Text span>
                  <CurrencyBadge
                    currency={Currency.BUZZ}
                    unitAmount={getUserBuzzBonusAmount()}
                    textColor={theme.colors.blue[4]}
                  />
                </Text>
                {' as a gift for use with on-site generation services.'}
              </Text>
            }
          />
          <TurnstileWidget
            options={{ size: 'normal' }}
            onSuccess={(token) => setCaptchaState({ status: 'success', token, error: null })}
            onError={(error) =>
              setCaptchaState({
                status: 'error',
                token: null,
                error: `There was an error generating the captcha: ${error}`,
              })
            }
            siteKey={env.NEXT_PUBLIC_CF_MANAGED_TURNSTILE_SITEKEY}
            onExpire={(token) =>
              setCaptchaState({ status: 'expired', token, error: 'Captcha token expired' })
            }
          />
          {captchaState.status === 'error' && (
            <Text size="xs" c="red">
              {captchaState.error}
            </Text>
          )}
          <TurnstilePrivacyNotice />
          <Group justify="space-between">
            <OnboardingAbortButton size="lg">Sign Out</OnboardingAbortButton>
            <Button size="lg" onClick={handleStepComplete} loading={isLoading}>
              Done
            </Button>
          </Group>
        </Stack>
      </Stack>
    </Container>
  );
}
