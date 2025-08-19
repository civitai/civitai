import {
  Button,
  Stack,
  Text,
  Group,
  Container,
  Loader,
  ThemeIcon,
  TextInput,
  useMantineTheme,
} from '@mantine/core';
import { useState } from 'react';

import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { IconCheck, IconX, IconProgressBolt } from '@tabler/icons-react';
import { useDebouncedValue } from '@mantine/hooks';
import { useReferralsContext } from '~/components/Referrals/ReferralsProvider';
import { constants } from '~/server/common/constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Currency } from '~/shared/utils/prisma/enums';
import { EarningBuzz, SpendingBuzz } from '../Buzz/FeatureCards/FeatureCards';
import { CurrencyBadge } from '../Currency/CurrencyBadge';
import {
  checkUserCreatedAfterBuzzLaunch,
  getUserBuzzBonusAmount,
} from '~/server/common/user-helpers';
import { OnboardingSteps } from '~/server/common/enums';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { useOnboardingContext } from '~/components/Onboarding/OnboardingProvider';
import * as z from 'zod';
import type { CaptchaState } from '~/components/TurnstileWidget/TurnstileWidget';
import {
  TurnstilePrivacyNotice,
  TurnstileWidget,
} from '~/components/TurnstileWidget/TurnstileWidget';
import { showErrorNotification } from '~/utils/notifications';
import { env } from '~/env/client';

const referralSchema = z.object({
  code: z
    .string()
    .trim()
    .refine((code) => !code || code.length > constants.referrals.referralCodeMinLength, {
      error: `Referral codes must be at least ${
        constants.referrals.referralCodeMinLength + 1
      } characters long`,
    })
    .optional(),
  source: z.string().optional(),
});

export function OnboardingBuzz() {
  const { next } = useOnboardingContext();
  const { code, source } = useReferralsContext();
  const theme = useMantineTheme();
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const [referralError, setReferralError] = useState('');
  const [userReferral, setUserReferral] = useState(
    !currentUser?.referral
      ? { code, source, showInput: false }
      : { code: '', source: '', showInput: false }
  );
  const [captchaState, setCaptchaState] = useState<CaptchaState>({
    status: null,
    token: null,
    error: null,
  });
  const [debouncedUserReferralCode] = useDebouncedValue(userReferral.code, 300);
  const isProjectOdyssey = source === 'project_odyssey';

  const {
    data: referrer,
    isLoading: referrerLoading,
    isRefetching: referrerRefetching,
  } = trpc.user.userByReferralCode.useQuery(
    { userReferralCode: debouncedUserReferralCode as string },
    {
      enabled:
        features.buzz &&
        !currentUser?.referral &&
        !!debouncedUserReferralCode &&
        debouncedUserReferralCode.length > constants.referrals.referralCodeMinLength,
    }
  );

  const { mutate, isLoading } = useOnboardingStepCompleteMutation();
  const handleStepComplete = () => {
    if (referrerRefetching) return;

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

    const result = referralSchema.safeParse(userReferral);
    if (!result.success)
      return setReferralError(result.error.format().code?._errors[0] ?? 'Invalid value');

    mutate(
      {
        step: OnboardingSteps.Buzz,
        userReferralCode: showReferral ? userReferral.code : undefined,
        source: showReferral ? userReferral.source : undefined,
        recaptchaToken: captchaState.token,
      },
      { onSuccess: () => next() }
    );
  };

  const showReferral =
    !isProjectOdyssey &&
    !!currentUser &&
    !currentUser.referral &&
    checkUserCreatedAfterBuzzLaunch(currentUser);

  return (
    <Container size="sm" px={0}>
      <Stack>
        <StepperTitle
          title="Buzz"
          description={
            <Text>
              {`At Civitai, we have something special called ⚡Buzz! It's our way of rewarding you for engaging with the community and you can use it to show love to your favorite creators and more. Learn more about it below, or whenever you need a refresher from your `}
              <IconProgressBolt size={20} style={{ verticalAlign: 'middle', display: 'inline' }} />
              {` Buzz Dashboard.`}
            </Text>
          }
        />
        <Stack gap="xl">
          <Group align="start" className="*:grow">
            <SpendingBuzz asList />
            <EarningBuzz asList />
          </Group>
          <StepperTitle
            title="Getting Started"
            description={
              <Text>
                To get you started, we will grant you{' '}
                <Text span>
                  {currentUser && (
                    <CurrencyBadge
                      currency={Currency.BUZZ}
                      unitAmount={getUserBuzzBonusAmount(currentUser)}
                      textColor={theme.colors.blue[4]}
                    />
                  )}
                </Text>
                {currentUser?.isMember
                  ? ' as a gift for being a supporter for use with on-site generation services.'
                  : ' as a gift for use with on-site generation services.'}
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
            <Button
              size="lg"
              onClick={handleStepComplete}
              loading={isLoading || referrerRefetching}
            >
              Done
            </Button>
          </Group>
          {showReferral && (
            <Button
              variant="subtle"
              mt="-md"
              onClick={() =>
                setUserReferral((current) => ({
                  ...current,
                  showInput: !current.showInput,
                  code,
                }))
              }
            >
              Have a referral code? Click here to claim a bonus
            </Button>
          )}

          {showReferral && userReferral.showInput && (
            <TextInput
              size="lg"
              label="Referral Code"
              description={
                <Text size="sm">
                  Both you and the person who referred you will receive{' '}
                  <Text span>
                    <CurrencyBadge
                      currency={Currency.BUZZ}
                      unitAmount={constants.buzz.referralBonusAmount}
                    />
                  </Text>{' '}
                  bonus with a valid referral code.
                </Text>
              }
              error={referralError}
              value={userReferral.code ?? ''}
              onChange={(e) => setUserReferral((current) => ({ ...current, code: e.target.value }))}
              rightSection={
                userReferral.code &&
                userReferral.code.length > constants.referrals.referralCodeMinLength &&
                (referrerLoading || referrerRefetching) ? (
                  <Loader size="sm" mr="xs" />
                ) : (
                  userReferral.code &&
                  userReferral.code.length > constants.referrals.referralCodeMinLength && (
                    <ThemeIcon
                      variant="outline"
                      color={referrer ? 'green' : 'red'}
                      radius="xl"
                      mr="xs"
                    >
                      {!!referrer ? <IconCheck size="1.25rem" /> : <IconX size="1.25rem" />}
                    </ThemeIcon>
                  )
                )
              }
              autoFocus
            />
          )}
        </Stack>
      </Stack>
    </Container>
  );
}
