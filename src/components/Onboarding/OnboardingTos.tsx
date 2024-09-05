import {
  Button,
  Center,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Title,
  TypographyStylesProvider,
} from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { useOnboardingWizardContext } from '~/components/Onboarding/OnboardingWizard';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import rehypeRaw from 'rehype-raw';

import { OnboardingSteps } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { useState } from 'react';
import { CaptchaState, TurnstileWidget } from '~/components/TurnstileWidget/TurnstileWidget';

export function OnboardingTos() {
  const [captchaState, setCaptchaState] = useState<CaptchaState>({
    status: null,
    token: null,
    error: null,
  });

  const { next } = useOnboardingWizardContext();
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
      { step: OnboardingSteps.TOS, recaptchaToken: captchaState.token },
      { onSuccess: () => next() }
    );
  };

  const { data: terms, isLoading: termsLoading } = trpc.content.get.useQuery({ slug: 'tos' });
  console.log(captchaState);

  return (
    <Stack>
      <StepperTitle
        title="Terms of Service"
        description="Please take a moment to review and accept our terms of service."
      />
      <ScrollArea
        style={{ height: 400 }}
        type="auto"
        p="md"
        sx={(theme) => ({
          border: `1px solid ${
            theme.colorScheme === 'light' ? theme.colors.gray[9] : theme.colors.gray[7]
          }`,
        })}
      >
        {termsLoading ? (
          <Center h={366}>
            <Loader size="lg" />
          </Center>
        ) : (
          terms && (
            <>
              <Title order={1}>{terms.title}</Title>
              <TypographyStylesProvider>
                <CustomMarkdown rehypePlugins={[rehypeRaw]}>{terms.content}</CustomMarkdown>
              </TypographyStylesProvider>
            </>
          )
        )}
      </ScrollArea>
      {!termsLoading && (
        <Group position="apart" align="flex-start">
          <OnboardingAbortButton showWarning>Decline</OnboardingAbortButton>
          <Button
            rightIcon={<IconCheck />}
            size="lg"
            onClick={handleStepComplete}
            loading={isLoading}
            disabled={captchaState.status !== 'success'}
          >
            Accept
          </Button>
        </Group>
      )}
      <TurnstileWidget
        onSuccess={(token) => setCaptchaState({ status: 'success', token, error: null })}
        onError={(error) =>
          setCaptchaState({
            status: 'error',
            token: null,
            error: `There was an error generating the captcha: ${error}`,
          })
        }
        onExpire={(token) =>
          setCaptchaState({ status: 'expired', token, error: 'Captcha token expired' })
        }
      />
    </Stack>
  );
}
