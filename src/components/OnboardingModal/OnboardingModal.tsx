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
  TextInput,
  ButtonProps,
  Card,
  Switch,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { Form, InputText, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { LogoBadge } from '~/components/Logo/LogoBadge';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { IconCheck, IconX, IconProgressBolt } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';
import { useDebouncedValue } from '@mantine/hooks';
import { ModerationCard } from '~/components/Account/ModerationCard';
import { invalidateModeratedContent } from '~/utils/query-invalidation-utils';
import { usernameInputSchema } from '~/server/schema/user.schema';
import { NewsletterToggle } from '~/components/Account/NewsletterToggle';
import { useReferralsContext } from '~/components/Referrals/ReferralsProvider';
import { RECAPTCHA_ACTIONS, constants } from '~/server/common/constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Currency } from '@prisma/client';
import { EarningBuzz, SpendingBuzz } from '../Buzz/FeatureCards/FeatureCards';
import { CurrencyBadge } from '../Currency/CurrencyBadge';
import {
  checkUserCreatedAfterBuzzLaunch,
  getUserBuzzBonusAmount,
} from '~/server/common/user-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useRecaptchaToken } from '../Recaptcha/useReptchaToken';
import { RecaptchaNotice } from '../Recaptcha/RecaptchaWidget';
import { OnboardingSteps } from '~/server/common/enums';

const schema = z.object({
  username: usernameInputSchema,
  email: z
    .string({
      invalid_type_error: 'Please provide an email',
      required_error: 'Please provide an email',
    })
    .email(),
});

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

export default function OnboardingModal() {
  const user = useCurrentUser();
  const utils = trpc.useUtils();
  const { code, source } = useReferralsContext();
  const { classes: stepperClasses, theme } = useStepperStyles();
  const { classes } = useStyles();
  const features = useFeatureFlags();

  const [userReferral, setUserReferral] = useState(
    !user?.referral
      ? { code, source, showInput: false }
      : { code: '', source: '', showInput: false }
  );
  const [referralError, setReferralError] = useState('');

  const form = useForm({
    schema,
    mode: 'onChange',
    shouldUnregister: false,
    defaultValues: { ...user },
  });
  const username = form.watch('username');
  const [debounced] = useDebouncedValue(username, 300);
  const [debouncedUserReferralCode] = useDebouncedValue(userReferral.code, 300);

  const onboarded = {
    tos: !!user?.tos,
    profile: !!user?.username && !!user?.email,
    content: !user?.onboardingSteps?.includes(OnboardingSteps.BrowsingLevels),
    buzz: !user?.onboardingSteps?.includes(OnboardingSteps.Buzz),
  };
  const stepCount = Object.keys(onboarded).length;
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
  const {
    data: referrer,
    isLoading: referrerLoading,
    isRefetching: referrerRefetching,
  } = trpc.user.userByReferralCode.useQuery(
    { userReferralCode: debouncedUserReferralCode as string },
    {
      enabled:
        features.buzz &&
        !user?.referral &&
        !!debouncedUserReferralCode &&
        debouncedUserReferralCode.length > constants.referrals.referralCodeMinLength,
    }
  );

  const { token: recaptchaToken, loading: isLoadingRecaptcha } = useRecaptchaToken(
    RECAPTCHA_ACTIONS.COMPLETE_ONBOARDING
  );

  const { mutate, isLoading, error } = trpc.user.update.useMutation();
  const { mutate: acceptTOS, isLoading: acceptTOSLoading } = trpc.user.acceptTOS.useMutation();
  const { mutate: completeStep, isLoading: completeStepLoading } =
    trpc.user.completeOnboardingStep.useMutation({
      async onSuccess() {
        await user?.refresh();
        await invalidateModeratedContent(utils);
        // context.closeModal(id);
      },
      onError(error) {
        showErrorNotification({
          title: 'Cannot save',
          error: new Error(error.message),
          // reason: 'An unknown error occurred. Please try again later',
        });
      },
    });

  const goNext = () => {
    if (activeStep >= stepCount) return;
    setActiveStep((x) => x + 1);
  };

  const handleSubmit = (values: z.infer<typeof schema>) => {
    if (!user) return;

    mutate(
      // TOS is true here because it was already accepted
      { ...user, ...values, tos: true },
      {
        async onSuccess() {
          await user?.refresh();
          goNext();
        },
      }
    );
  };

  const handleAcceptTOS = () => {
    acceptTOS(undefined, {
      async onSuccess() {
        await user?.refresh();
        goNext();
      },
    });
  };
  const handleCompleteStep = (step: OnboardingStep) => {
    console.log({ recaptchaToken });
    if (!recaptchaToken) {
      showErrorNotification({
        title: 'Cannot save',
        error: new Error('Recaptcha token is missing'),
        // reason: 'An unknown error occurred. Please try again later',
      });

      return;
    }

    completeStep(
      { step, recaptchaToken },
      {
        onSuccess: (result) => {
          if (result.onboardingSteps.length > 0) {
            goNext();
            return;
          }

          if (user) {
            mutate({
              ...user,
              userReferralCode: showReferral ? userReferral.code : undefined,
              source: showReferral ? userReferral.source : undefined,
            });
          }
        },
      }
    );
  };
  const handleCompleteBuzzStep = () => {
    if (referrerRefetching) return;
    setReferralError('');

    const result = referralSchema.safeParse(userReferral);
    if (!result.success)
      return setReferralError(result.error.format().code?._errors[0] ?? 'Invalid value');

    handleCompleteStep(OnboardingStep.Buzz);
  };

  useEffect(() => {
    if (activeStep === 1 && user) form.reset({ email: user.email, username: user.username });
    // Don't remove the eslint disable below, it's needed to prevent infinite loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email, user?.username]);

  const showReferral = !!user && !user.referral && checkUserCreatedAfterBuzzLaunch(user);

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
      <Stepper
        active={activeStep > -1 ? activeStep : 0}
        color="green"
        allowNextStepsSelect={false}
        classNames={stepperClasses}
      >
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
              <CancelButton showWarning>Decline</CancelButton>
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
                  {error && (
                    <Alert color="red" variant="light">
                      {error.data?.code === 'CONFLICT'
                        ? 'That username is already taken'
                        : error.message}
                    </Alert>
                  )}
                  <Group position="apart">
                    <CancelButton size="lg">Sign Out</CancelButton>
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
                  </Group>
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
                  </Group>
                }
                description="Personalize your AI content exploration! Fine-tune preferences for a delightful and safe browsing experience."
              />
              <Card withBorder className={classes.newsletterCard}>
                <Card.Section withBorder inheritPadding py="xs">
                  <Group position="apart">
                    <Text weight={500}>Send me the Civitai Newsletter!</Text>
                    <NewsletterToggle>
                      {({ subscribed, setSubscribed, isLoading: subscriptionLoading }) => (
                        <Switch
                          disabled={subscriptionLoading}
                          checked={subscribed}
                          onChange={({ target }) => setSubscribed(target.checked)}
                        />
                      )}
                    </NewsletterToggle>
                  </Group>
                </Card.Section>

                <Text lh={1.3} mt="xs">
                  Biweekly updates on industry news, new Civitai features, trending resources,
                  community contests, and more!
                </Text>
                <img
                  src="/images/newsletter-banner.png"
                  alt="Robot holding a newspaper"
                  className={classes.newsletterBot}
                />
              </Card>
              <ModerationCard cardless sections={['tags', 'nsfw']} instantRefresh={false} />
              <Text color="dimmed" size="xs">
                You can adjust these preferences at any time from your account page.
              </Text>
              <Group position="apart">
                <CancelButton size="lg">Sign Out</CancelButton>
                <Button
                  size="lg"
                  onClick={() => handleCompleteStep(OnboardingStep.Moderation)}
                  loading={completeStepLoading}
                >
                  Save
                </Button>
              </Group>
            </Stack>
          </Container>
        </Stepper.Step>
        <Stepper.Step label="Buzz" description="Power-up your experience">
          <Container size="sm" px={0}>
            {isLoadingRecaptcha ? (
              <Center py="lg">
                <Loader size="lg" />
              </Center>
            ) : (
              <Stack spacing="xl">
                <Text>
                  {`On Civitai, we have something special called ⚡Buzz! It's our way of rewarding you for engaging with the community and you can use it to show love to your favorite creators and more. Learn more about it below, or whenever you need a refresher from your `}
                  <IconProgressBolt
                    color={theme.colors.yellow[7]}
                    size={20}
                    style={{ verticalAlign: 'middle' }}
                  />
                  {` Buzz Dashboard.`}
                </Text>
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
                        {user && (
                          <CurrencyBadge
                            currency={Currency.BUZZ}
                            unitAmount={getUserBuzzBonusAmount(user)}
                          />
                        )}
                      </Text>
                      {user?.isMember ? ' as a gift for being a supporter.' : ' as a gift.'}
                    </Text>
                  }
                />
                <Group position="apart">
                  <CancelButton size="lg">Sign Out</CancelButton>
                  <Button
                    size="lg"
                    onClick={handleCompleteBuzzStep}
                    loading={completeStepLoading || referrerRefetching}
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
                    onChange={(e) =>
                      setUserReferral((current) => ({ ...current, code: e.target.value }))
                    }
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
            )}
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

const CancelButton = ({
  children,
  showWarning,
  ...props
}: ButtonProps & { showWarning?: boolean }) => {
  const handleCancelOnboarding = () => signOut();

  return (
    <Stack spacing={0}>
      <Button {...props} variant="default" onClick={handleCancelOnboarding}>
        {children}
      </Button>
      {showWarning && (
        <Text size="xs" color="dimmed">
          You will be logged out.
        </Text>
      )}
    </Stack>
  );
};

const useStepperStyles = createStyles((theme, _params, getRef) => ({
  steps: {
    marginTop: 20,
    marginBottom: 20,
    [containerQuery.smallerThan('xs')]: {
      marginTop: 0,
      marginBottom: 0,
    },
  },
  step: {
    [containerQuery.smallerThan('md')]: {
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
    [containerQuery.smallerThan('md')]: {
      display: 'none',
    },
  },
  stepDescription: {
    whiteSpace: 'nowrap',
  },
  stepIcon: {
    [containerQuery.smallerThan('sm')]: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 24,
      height: 24,
      minWidth: 24,
    },
  },
  stepCompletedIcon: {
    [containerQuery.smallerThan('sm')]: {
      width: 14,
      height: 14,
      minWidth: 14,
      position: 'relative',
    },
  },
  separator: {
    [containerQuery.smallerThan('xs')]: {
      marginLeft: 4,
      marginRight: 4,
      minWidth: 10,
      // display: 'none',
    },
  },
}));

const useStyles = createStyles((theme) => ({
  newsletterCard: {
    position: 'relative',
    overflow: 'visible',
    borderColor: theme.colors.blue[5],
    marginTop: 60,
    [theme.fn.largerThan('sm')]: {
      marginTop: 70,
    },

    '&::before': {
      content: '""',
      position: 'absolute',
      left: '-3px',
      top: '-3px',
      background: theme.fn.linearGradient(
        10,
        theme.colors.blue[9],
        theme.colors.blue[7],
        theme.colors.blue[5],
        theme.colors.cyan[9],
        theme.colors.cyan[7],
        theme.colors.cyan[5]
      ),
      backgroundSize: '200%',
      borderRadius: theme.radius.sm,
      width: 'calc(100% + 6px)',
      height: 'calc(100% + 6px)',
      filter: 'blur(4px)',
      zIndex: -1,
      animation: 'glowing 20s linear infinite',
      transition: 'opacity .3s ease-in-out',
    },
  },
  newsletterBot: {
    objectPosition: 'top',
    objectFit: 'cover',
    position: 'absolute',
    top: -100,
    right: 0,
    width: 200,
    zIndex: -1,
  },
}));
