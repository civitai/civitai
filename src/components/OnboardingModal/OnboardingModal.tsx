import {
  Button,
  Stack,
  Text,
  Alert,
  Stepper,
  Title,
  Group,
  Center,
  Container,
  ScrollArea,
  Loader,
  createStyles,
  StackProps,
  ThemeIcon,
  Badge,
} from '@mantine/core';
import { useState } from 'react';
import { z } from 'zod';

import { Form, InputText, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { LogoBadge } from '~/components/Logo/LogoBadge';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { IconCheck, IconX, IconAlertCircle } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';
import { useDebouncedValue } from '@mantine/hooks';
import { ModerationCard } from '~/components/Account/ModerationCard';
import { invalidateModeratedContent } from '~/utils/query-invalidation-utils';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { usernameInputSchema } from '~/server/schema/user.schema';
import { NewsletterToggle } from '~/components/Account/NewsletterToggle';

const schema = z.object({
  username: usernameInputSchema,
  email: z
    .string({
      invalid_type_error: 'Please provide an email',
      required_error: 'Please provide an email',
    })
    .email(),
  userReferralCode: z.string().optional(),
  source: z.string().optional(),
});

export default function OnboardingModal() {
  const user = useCurrentUser();
  const utils = trpc.useContext();
  const { classes } = useStyles();

  const form = useForm({
    schema,
    mode: 'onChange',
    shouldUnregister: false,
    defaultValues: { ...user },
  });
  const username = form.watch('username');
  const userReferralCode = form.watch('userReferralCode');
  const [debounced] = useDebouncedValue(username, 300);
  const [debouncedUserReferralCode] = useDebouncedValue(userReferralCode, 300);

  const onboarded = {
    tos: !!user?.tos,
    profile: !!user?.username || !!user?.email,
    content: !!user?.onboarded,
  };
  const [activeStep, setActiveStep] = useState(Object.values(onboarded).indexOf(false));

  const { data: terms, isLoading: termsLoading } = trpc.content.get.useQuery(
    { slug: 'tos' },
    { enabled: !onboarded.tos }
  );

  // Check if username is available
  const { data: usernameAvailable, isRefetching: usernameAvailableLoading } =
    trpc.user.usernameAvailable.useQuery(
      { username: debounced },
      { enabled: !!username && username.length >= 3 }
    );
  // Confirm user referral code:
  const { data: referrer, isLoading: referrerLoading } = trpc.user.userByReferralCode.useQuery(
    { userReferralCode: debouncedUserReferralCode as string },
    { enabled: !!debouncedUserReferralCode && debouncedUserReferralCode.length >= 3 }
  );

  const { mutate, isLoading, error } = trpc.user.update.useMutation();
  const { mutate: acceptTOS, isLoading: acceptTOSLoading } = trpc.user.acceptTOS.useMutation();
  const { mutate: completeOnboarding, isLoading: completeOnboardingLoading } =
    trpc.user.completeOnboarding.useMutation({
      async onSuccess() {
        user?.refresh();
        await invalidateModeratedContent(utils);
        // context.closeModal(id);
      },
    });

  const handleSubmit = (values: z.infer<typeof schema>) => {
    if (!user) return;
    // TOS is true here because it was already accepted
    mutate(
      { ...user, ...values, tos: true },
      {
        onSuccess: async () => {
          setActiveStep((x) => x + 1);
        },
      }
    );
  };

  const handleDeclineTOS = () => signOut();
  const handleAcceptTOS = () => {
    acceptTOS(undefined, {
      async onSuccess() {
        setActiveStep((x) => x + 1);
      },
    });
  };
  const handleCompleteOnboarding = () => {
    completeOnboarding();
  };

  return (
    <Container size="lg" px={0}>
      <Center>
        <Group spacing="xs">
          <LogoBadge w={86} />
          <Stack spacing={0} mt={-5}>
            <Title sx={{ lineHeight: 1 }}>Welcome!</Title>
            <Text>{`Let's setup your account`}</Text>
          </Stack>
        </Group>
      </Center>
      <Stepper active={activeStep} color="green" allowNextStepsSelect={false} classNames={classes}>
        <Stepper.Step label="Terms" description="Review our terms">
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
              {termsLoading || !terms ? (
                <Center py="lg">
                  <Loader size="lg" />
                </Center>
              ) : (
                <>
                  <Title order={1}>{terms.title}</Title>
                  <ReactMarkdown rehypePlugins={[rehypeRaw]} className="markdown-content">
                    {terms.content}
                  </ReactMarkdown>
                </>
              )}
            </ScrollArea>
            <Group position="apart" align="flex-start">
              <Stack spacing={0}>
                <Button variant="default" onClick={handleDeclineTOS}>
                  Decline
                </Button>
                <Text size="xs" color="dimmed">
                  You will be logged out.
                </Text>
              </Stack>
              <Button
                rightIcon={<IconCheck />}
                size="lg"
                onClick={handleAcceptTOS}
                loading={acceptTOSLoading}
              >
                Accept
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Account" description="Verify your details">
          <Container size="xs" px={0}>
            <Stack>
              <StepperTitle
                title="Account Details"
                description="Please verify your account details"
              />
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
                  <InputText
                    size="lg"
                    name="userReferralCode"
                    label="Referral Code"
                    type="text"
                    clearable={false}
                    error={
                      userReferralCode && userReferralCode.length <= 3
                        ? 'Referral codes must be longer than 3 characters'
                        : undefined
                    }
                    rightSection={
                      userReferralCode && userReferralCode.length > 3 && referrerLoading ? (
                        <Loader size="sm" mr="xs" />
                      ) : (
                        userReferralCode &&
                        userReferralCode.length > 3 && (
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
                  />

                  {error && (
                    <Alert color="red" variant="light">
                      {error.data?.code === 'CONFLICT'
                        ? 'That username is already taken'
                        : error.message}
                    </Alert>
                  )}
                  <Button
                    disabled={
                      !usernameAvailable ||
                      !username ||
                      usernameAvailableLoading ||
                      !(form.formState.isValid || !form.formState.isDirty)
                    }
                    size="lg"
                    type="submit"
                    loading={isLoading}
                  >
                    Save
                  </Button>
                </Stack>
              </Form>
            </Stack>
          </Container>
        </Stepper.Step>
        <Stepper.Step label="Experience" description="Personalize your experience">
          <Container size="xs" px={0}>
            <Stack>
              <StepperTitle
                title={
                  <Group spacing="xs">
                    <Title order={2}>Content Experience</Title>
                    <Badge color="yellow" size="xs">
                      Beta
                    </Badge>
                  </Group>
                }
                description="Personalize your AI content exploration! Fine-tune preferences for a delightful and safe browsing experience."
              />
              <Text color="dimmed" size="xs">
                You can adjust these preferences at any time from your account page.
              </Text>
              <ModerationCard cardless sections={['tags', 'nsfw']} instantRefresh={false} />
              <AlertWithIcon
                color="yellow"
                icon={<IconAlertCircle />}
                iconColor="yellow"
                size="sm"
              >{`This feature is in beta. There may still be some content visible to you that you've requested to hide.`}</AlertWithIcon>
              <NewsletterToggle
                label="Send me the Civitai Newsletter"
                description="We'll send you model and creator highlights, AI news, as well as comprehensive guides from
                leaders in the AI Content Universe. We hate spam as much as you do."
              />
              <Button
                size="lg"
                onClick={handleCompleteOnboarding}
                loading={completeOnboardingLoading}
              >
                Done
              </Button>
            </Stack>
          </Container>
        </Stepper.Step>
      </Stepper>
    </Container>
  );
}

const StepperTitle = ({
  title,
  description,
  ...props
}: { title: React.ReactNode; description: React.ReactNode } & Omit<StackProps, 'title'>) => {
  return (
    <Stack spacing={4} {...props}>
      <Title order={3} sx={{ lineHeight: 1.1 }}>
        {title}
      </Title>
      <Text>{description}</Text>
    </Stack>
  );
};

const useStyles = createStyles((theme, _params, getRef) => ({
  steps: {
    marginTop: 20,
    marginBottom: 20,
    [theme.fn.smallerThan('xs')]: {
      marginTop: 0,
      marginBottom: 0,
    },
  },
  step: {
    [theme.fn.smallerThan('xs')]: {
      '&[data-progress]': {
        display: 'flex',
        [`& .${getRef('stepBody')}`]: {
          display: 'block',
        },
      },
    },
  },
  stepBody: {
    ref: getRef('stepBody'),
    [theme.fn.smallerThan('xs')]: {
      display: 'none',
    },
  },
  stepDescription: {
    whiteSpace: 'nowrap',
  },
  separator: {
    [theme.fn.smallerThan('xs')]: {
      marginLeft: 4,
      marginRight: 4,
      minWidth: 10,
      // display: 'none',
    },
  },
}));
