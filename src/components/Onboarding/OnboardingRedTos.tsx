import {
  Button,
  Center,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Title,
  TypographyStylesProvider,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { useOnboardingContext } from '~/components/Onboarding/OnboardingProvider';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import rehypeRaw from 'rehype-raw';

import { OnboardingSteps } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

export function OnboardingRedTos() {
  const { next } = useOnboardingContext();
  const { mutate, isLoading } = useOnboardingStepCompleteMutation();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const handleStepComplete = () => {
    mutate({ step: OnboardingSteps.RedTOS }, { onSuccess: () => next() });
  };

  const { data: terms, isLoading: termsLoading } = trpc.content.get.useQuery({ slug: 'tos' });

  return (
    <Stack>
      <StepperTitle
        title="RED Terms of Service"
        description="Please take a moment to review and accept our terms of service."
      />
      <ScrollArea
        type="auto"
        p="md"
        style={{
          height: 400,
          border: `1px solid ${
            colorScheme === 'light' ? theme.colors.gray[9] : theme.colors.gray[7]
          }`,
        }}
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
        <Group justify="space-between" align="flex-start">
          <OnboardingAbortButton showWarning>Decline</OnboardingAbortButton>
          <Button
            rightIcon={<IconCheck />}
            size="lg"
            onClick={handleStepComplete}
            loading={isLoading}
          >
            Accept
          </Button>
        </Group>
      )}
    </Stack>
  );
}
