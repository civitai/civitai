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
import { useRef, useState } from 'react';

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
import type {
  CaptchaState,
  TurnstileWidgetRef,
} from '~/components/TurnstileWidget/TurnstileWidget';
import {
  TurnstilePrivacyNotice,
  TurnstileWidget,
} from '~/components/TurnstileWidget/TurnstileWidget';
import { showErrorNotification } from '~/utils/notifications';
import { env } from '~/env/client';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function OnboardingBuzz() {
  const { next } = useOnboardingContext();
  const theme = useMantineTheme();
  const domainColor = useDomainColor();
  const isGreen = domainColor === 'green';
  const paidAccountType = isGreen ? 'green' : 'yellow';
  const blueConfig = useBuzzCurrencyConfig('blue');
  const paidConfig = useBuzzCurrencyConfig(paidAccountType);
  const paidLabel = isGreen ? 'Green' : 'Yellow';
  const features = useFeatureFlags();
  const [captchaState, setCaptchaState] = useState<CaptchaState>({
    status: null,
    token: null,
    error: null,
  });

  const turnstileRef = useRef<TurnstileWidgetRef | null>(null);
  const tokenReceivedAtRef = useRef<number | null>(null);
  const submitAttemptRef = useRef(0);
  const pageSessionIdRef = useRef<string>(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  );

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

    submitAttemptRef.current += 1;
    const token = captchaState.token;
    const tokenAgeMs = tokenReceivedAtRef.current
      ? Date.now() - tokenReceivedAtRef.current
      : undefined;
    const captchaDebug = {
      tokenAgeMs,
      submitAttempt: submitAttemptRef.current,
      widgetStatus: captchaState.status ?? undefined,
      tokenPrefix: token.slice(0, 8),
      pageSessionId: pageSessionIdRef.current,
    };

    const refreshCaptcha = () => {
      if (!features.onboardingCaptchaReset) return;
      turnstileRef.current?.reset();
      tokenReceivedAtRef.current = null;
      setCaptchaState({ status: null, token: null, error: null });
    };

    mutate(
      {
        step: OnboardingSteps.Buzz,
        recaptchaToken: token,
        captchaDebug,
      },
      {
        onSuccess: () => {
          refreshCaptcha();
          next();
        },
        onError: () => {
          refreshCaptcha();
        },
      }
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
            ref={turnstileRef}
            options={{ size: 'normal' }}
            onSuccess={(token) => {
              tokenReceivedAtRef.current = Date.now();
              setCaptchaState({ status: 'success', token, error: null });
            }}
            onError={(error) => {
              tokenReceivedAtRef.current = null;
              setCaptchaState({
                status: 'error',
                token: null,
                error: `There was an error generating the captcha: ${error}`,
              });
            }}
            siteKey={env.NEXT_PUBLIC_CF_MANAGED_TURNSTILE_SITEKEY}
            onExpire={(token) => {
              tokenReceivedAtRef.current = null;
              setCaptchaState({ status: 'expired', token, error: 'Captcha token expired' });
            }}
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
