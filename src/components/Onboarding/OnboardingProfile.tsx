import { Alert, Container, Loader, Stack, ThemeIcon, Group, Button } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { OnboardingAbortButton } from '~/components/Onboarding/OnboardingAbortButton';
import { useOnboardingWizardContext } from '~/components/Onboarding/OnboardingWizard';
import { useOnboardingStepCompleteMutation } from '~/components/Onboarding/onboarding.utils';
import { StepperTitle } from '~/components/Stepper/StepperTitle';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputText, useForm } from '~/libs/form';
import { OnboardingSteps } from '~/server/common/enums';
import { usernameInputSchema } from '~/server/schema/user.schema';
import { useDebouncer } from '~/utils/debouncer';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  username: usernameInputSchema,
  email: z
    .string({
      invalid_type_error: 'Please provide a valid email',
      required_error: 'Please provide an email',
    })
    .email(),
});

export function OnboardingProfile() {
  const currentUser = useCurrentUser();
  const { next } = useOnboardingWizardContext();
  const { mutate, isLoading, error } = useOnboardingStepCompleteMutation();

  const debouncer = useDebouncer(500);
  const [username, setUsername] = useState('');
  const [typing, setTyping] = useState(false);
  const { data: usernameAvailable, isRefetching: usernameAvailableLoading } =
    trpc.user.usernameAvailable.useQuery({ username }, { enabled: username.length >= 3 });

  const form = useForm({
    schema,
    mode: 'onChange',
    shouldUnregister: false,
    defaultValues: { ...currentUser },
  });

  const handleSubmit = (data: z.infer<typeof schema>) => {
    mutate({ step: OnboardingSteps.Profile, ...data }, { onSuccess: () => next() });
  };

  useEffect(() => {
    const subscription = form.watch((value, { name }) => {
      if (name === 'username') {
        const { username } = value;
        if (username) {
          setTyping(true);
          debouncer(() => {
            setUsername(username);
            setTyping(false);
          });
        }
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const buttonDisabled =
    !form.formState.isValid ||
    typing ||
    (form.formState.isDirty && (!usernameAvailable || usernameAvailableLoading));

  return (
    <Container size="xs" px={0}>
      <Stack>
        <StepperTitle title="Account Details" description="Please verify your account details" />
        <Form form={form} onSubmit={handleSubmit}>
          <Stack>
            <InputText size="lg" name="email" label="Email" type="email" withAsterisk />
            <InputText
              size="lg"
              name="username"
              label="Username"
              clearable={false}
              rightSection={
                usernameAvailableLoading ? (
                  <Loader size="sm" mr="xs" />
                ) : (
                  usernameAvailable !== undefined && (
                    <ThemeIcon
                      variant="outline"
                      color={!!username && usernameAvailable ? 'green' : 'red'}
                      radius="xl"
                      mr="xs"
                    >
                      {!!username && usernameAvailable ? (
                        <IconCheck size="1.25rem" />
                      ) : (
                        <IconX size="1.25rem" />
                      )}
                    </ThemeIcon>
                  )
                )
              }
              withAsterisk
            />
            {error && (
              <Alert color="red" variant="light">
                {error.data?.code === 'CONFLICT' ? 'That username is already taken' : error.message}
              </Alert>
            )}
            <Group position="apart">
              <OnboardingAbortButton size="lg">Sign Out</OnboardingAbortButton>
              <Button disabled={buttonDisabled} size="lg" type="submit" loading={isLoading}>
                Save
              </Button>
            </Group>
          </Stack>
        </Form>
      </Stack>
    </Container>
  );
}
