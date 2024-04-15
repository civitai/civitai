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
import ReactMarkdown from 'react-markdown';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { useOnboardingWizardContext } from '~/components/Onboarding/OnboardingWizard';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import rehypeRaw from 'rehype-raw';

import { OnboardingSteps } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { RECAPTCHA_ACTIONS } from '~/server/common/constants';
import { useRecaptchaToken } from '~/components/Recaptcha/useReptchaToken';

export function OnboardingTos() {
  const { next } = useOnboardingWizardContext();
  const { mutate, isLoading } = useOnboardingStepCompleteMutation();

  const { token: recaptchaToken, loading: isLoadingRecaptcha } = useRecaptchaToken(
    RECAPTCHA_ACTIONS.COMPLETE_ONBOARDING
  );

  const handleStepComplete = () => {
    if (!recaptchaToken)
      return showErrorNotification({
        title: 'Cannot save',
        error: new Error('Recaptcha token is missing'),
      });

    mutate({ step: OnboardingSteps.TOS, recaptchaToken }, { onSuccess: () => next() });
  };

  const { data: terms, isLoading: termsLoading } = trpc.content.get.useQuery({ slug: 'tos' });

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
                <ReactMarkdown rehypePlugins={[rehypeRaw]} className="markdown-content">
                  {terms.content}
                </ReactMarkdown>
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
            disabled={isLoadingRecaptcha || !recaptchaToken}
          >
            Accept
          </Button>
        </Group>
      )}
    </Stack>
  );
}
