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
import { Currency } from '@prisma/client';
import { EarningBuzz, SpendingBuzz } from '../Buzz/FeatureCards/FeatureCards';
import { CurrencyBadge } from '../Currency/CurrencyBadge';
import {
  checkUserCreatedAfterBuzzLaunch,
  getUserBuzzBonusAmount,
} from '~/server/common/user-helpers';
import { RecaptchaNotice } from '../Recaptcha/RecaptchaWidget';
import { OnboardingSteps } from '~/server/common/enums';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { useOnboardingWizardContext } from '~/components/Onboarding/OnboardingWizard';
import { z } from 'zod';

const referralSchema = z.object({
  code: z
    .string()
    .trim()
    .refine((code) => !code || code.length > constants.referrals.referralCodeMinLength, {
      message: `Referral codes must be at least ${
        constants.referrals.referralCodeMinLength + 1
      } characters long`,
    })
    .optional(),
  source: z.string().optional(),
});

export function OnboardingBuzz() {
  const { next } = useOnboardingWizardContext();
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
  const [debouncedUserReferralCode] = useDebouncedValue(userReferral.code, 300);

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

    const result = referralSchema.safeParse(userReferral);
    if (!result.success)
      return setReferralError(result.error.format().code?._errors[0] ?? 'Invalid value');

    mutate(
      {
        step: OnboardingSteps.Buzz,
        userReferralCode: showReferral ? userReferral.code : undefined,
        source: showReferral ? userReferral.source : undefined,
      },
      { onSuccess: () => next() }
    );
  };

  const showReferral =
    !!currentUser && !currentUser.referral && checkUserCreatedAfterBuzzLaunch(currentUser);

  return (
    <Container size="sm" px={0}>
      <Stack>
        <StepperTitle
          title="Buzz"
          description={
            <Text>
              {`At Civitai, we have something special called ⚡Buzz! It's our way of rewarding you for engaging with the community and you can use it to show love to your favorite creators and more. Learn more about it below, or whenever you need a refresher from your `}
              <IconProgressBolt
                color={theme.colors.yellow[7]}
                size={20}
                style={{ verticalAlign: 'middle', display: 'inline' }}
              />
              {` Buzz Dashboard.`}
            </Text>
          }
        />
        <Stack spacing="xl">
          <Group align="start" sx={{ ['&>*']: { flexGrow: 1 } }}>
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
                    />
                  )}
                </Text>
                {currentUser?.isMember ? ' as a gift for being a supporter.' : ' as a gift.'}
              </Text>
            }
          />
          <Group position="apart">
            <OnboardingAbortButton size="lg">Sign Out</OnboardingAbortButton>
            <Button
              size="lg"
              onClick={handleStepComplete}
              loading={isLoading || referrerRefetching}
            >
              Done
            </Button>
          </Group>
          <RecaptchaNotice />
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
