import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { IsClient } from '~/components/IsClient/IsClient';
import {
  GenerateFormModel,
  blockedRequest,
  generateFormSchema,
} from '~/server/schema/generation.schema';
import {
  getFormData,
  useDerivedGenerationState,
  useGenerationFormStore,
  keyupEditAttention,
  useGenerationStatus,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import React, { useEffect, useState } from 'react';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import { generation, getGenerationConfig } from '~/server/common/constants';
import { generationPanel, generationStore, useGenerationStore } from '~/store/generation.store';
import { useCreateGenerationRequest } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { isDefined } from '~/utils/type-guards';
import {
  Form,
  InputNumberSlider,
  InputSegmentedControl,
  InputSelect,
  InputSwitch,
  InputTextArea,
} from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { parsePromptMetadata } from '~/utils/metadata';
import { imageGenerationSchema } from '~/server/schema/image.schema';
import { showErrorNotification } from '~/utils/notifications';
import {
  Anchor,
  Button,
  Card,
  Center,
  NumberInputProps,
  Paper,
  SliderProps,
  Stack,
  Group,
  Text,
  createStyles,
  Accordion,
  CopyButton,
  Input,
  Divider,
  Badge,
  Alert,
  ThemeIcon,
  List,
  LoadingOverlay,
} from '@mantine/core';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useLoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import InputResourceSelect from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import { PersistentAccordion } from '~/components/PersistentAccordion/PersistantAccordion';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import {
  IconAlertTriangle,
  IconArrowAutofitDown,
  IconCheck,
  IconCopy,
  IconPlus,
} from '@tabler/icons-react';
import InputResourceSelectMultiple from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { ModelType } from '@prisma/client';
import { getDisplayName } from '~/utils/string-helpers';
import { getHotkeyHandler, useLocalStorage } from '@mantine/hooks';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { NextLink } from '@mantine/next';
import { IconLock } from '@tabler/icons-react';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import InputQuantity from '~/components/ImageGeneration/GenerationForm/InputQuantity';
import Link from 'next/link';

const BUZZ_CHARGE_NOTICE_END = new Date('2024-04-14T00:00:00Z');

const GenerationFormInner = ({ onSuccess }: { onSuccess?: () => void }) => {
  const { classes, cx, theme } = useStyles();
  const currentUser = useCurrentUser();
  const { requireLogin } = useLoginRedirect({ reason: 'image-gen', returnUrl: '/generate' });
  const [promptWarning, setPromptWarning] = useState<string | null>(null);
  const [reviewed, setReviewed] = useLocalStorage({
    key: 'review-generation-terms',
    defaultValue: window?.localStorage?.getItem('review-generation-terms') === 'true',
  });
  const [opened, setOpened] = useState(false);
  const { nsfw, quantity, prompt } = useGenerationFormStore.getState();
  const defaultValues = {
    ...generation.defaultValues,
    // nsfw: nsfw ?? currentUser?.showNsfw,
    nsfw: nsfw ?? false,
    quantity: quantity ?? generation.defaultValues.quantity,
    // Use solely to to update the resource oimits based on tier
    tier: currentUser?.tier ?? 'free',
  };
  const features = useFeatureFlags();

  const form = useForm<GenerateFormModel>({
    resolver: zodResolver(generateFormSchema),
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    shouldUnregister: false,
    defaultValues,
  });

  const { limits, ...status } = useGenerationStatus();

  function getSteps(steps: number, limit: number) {
    return steps > limit ? limit : steps;
  }

  useEffect(() => {
    const storedState = useGenerationFormStore.getState();
    const steps = getSteps(storedState.steps ?? defaultValues.steps, limits.steps);
    if (steps !== storedState.steps) useGenerationFormStore.setState({ steps });
    form.reset({
      ...defaultValues,
      ...storedState,
      steps,
      // Use solely to to update the resource oimits based on tier
      tier: currentUser?.tier ?? 'free',
    });
    const subscription = form.watch((value) => {
      useGenerationFormStore.setState({ ...(value as GenerateFormModel) }, true);
    });
    return () => subscription.unsubscribe();
  }, [currentUser]); // eslint-disable-line

  const {
    totalCost,
    baseModel,
    hasResources,
    trainedWords,
    additionalResourcesCount,
    samplerCfgOffset,
    isSDXL,
    unstableResources,
    isCalculatingCost,
    draft,
    costEstimateError,
  } = useDerivedGenerationState();

  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const handleClearAll = () => {
    const { nsfw, quantity } = useGenerationFormStore.getState();
    setPromptWarning(null);
    form.reset({
      ...generation.defaultValues,
      nsfw,
      quantity,
    });
  };

  const createData = useGenerationStore((state) => state.data);

  // sync form with `create` data
  useEffect(() => {
    if (!createData) return;
    const { data, type } = createData;
    const formData = getFormData(type, data);
    useGenerationStore.setState({ data: undefined });
    // form.reset(formData);
    for (const key in formData) {
      const _key = key as keyof typeof formData;
      if (key === 'steps')
        form.setValue(_key as any, getSteps((formData[_key] as number) ?? 0, limits.steps));
      else form.setValue(_key as any, formData[_key]);
    }
  }, [createData]); // eslint-disable-line

  // #region [mutations]
  const { mutateAsync, isLoading } = useCreateGenerationRequest();
  const handleSubmit = async (data: GenerateFormModel) => {
    if (!currentUser) {
      requireLogin();
      generationPanel.close();
      return;
    }
    const { model, resources = [], vae, ...params } = data;
    const _resources = [model, ...resources, vae].filter(isDefined).map((resource) => {
      if (resource.modelType === 'TextualInversion')
        return { ...resource, triggerWord: resource.trainedWords[0] };
      return resource;
    });

    const performTransaction = async () => {
      try {
        await mutateAsync({
          resources: _resources.filter((x) => x.covered !== false),
          params: { ...params, baseModel },
        });
        onSuccess?.();
        // if (!Router.pathname.includes('/generate')) generationPanel.setView('queue');
      } catch (e) {
        const error = e as Error;
        if (error.message.startsWith('Your prompt was flagged')) {
          setPromptWarning(error.message + '. Continued attempts will result in an automated ban.');
          currentUser?.refresh();
        }

        // All other notifications are already sent in the mutation
      }
    };

    setPromptWarning(null);
    conditionalPerformTransaction(totalCost, performTransaction);
  };

  const { mutateAsync: reportProhibitedRequest } = trpc.user.reportProhibitedRequest.useMutation();
  const handleError = async (e: unknown) => {
    const promptError = (e as any)?.prompt as any;
    if (promptError?.type === 'custom') {
      const status = blockedRequest.status();
      setPromptWarning(promptError.message);
      if (status === 'notified' || status === 'muted') {
        const isBlocked = await reportProhibitedRequest({ prompt });
        if (isBlocked) currentUser?.refresh();
      }
    } else {
      setPromptWarning(null);
    }
  };
  // #endregion

  // #region [handle parse prompt]
  const [showFillForm, setShowFillForm] = useState(false);
  const handleParsePrompt = async () => {
    const prompt = form.getValues('prompt');
    const metadata = parsePromptMetadata(prompt);
    const result = imageGenerationSchema.safeParse(metadata);
    if (result.success) {
      generationStore.setParams(result.data);
      setShowFillForm(false);
    } else {
      console.error(result.error);
      showErrorNotification({
        title: 'Unable to parse prompt',
        error: new Error('We are unable to fill out the form with the provided prompt.'),
      });
    }
  };
  // #endregion

  const promptKeyHandler = getHotkeyHandler([
    ['mod+Enter', () => form.handleSubmit(handleSubmit)()],
    [
      'mod+ArrowUp',
      (event) => keyupEditAttention(event as React.KeyboardEvent<HTMLTextAreaElement>),
    ],
    [
      'mod+ArrowDown',
      (event) => keyupEditAttention(event as React.KeyboardEvent<HTMLTextAreaElement>),
    ],
  ]);

  const canGenerate = useGenerationContext((state) => state.canGenerate);
  const disableGenerateButton = !canGenerate || isCalculatingCost || isLoading;

  const cfgDisabled = !!draft;
  const samplerDisabled = !!draft;
  const stepsDisabled = !!draft;

  // Manually handle error display for prompt box
  const { errors } = form.formState;
  const atLimit = additionalResourcesCount >= limits.resources;

  return (
    <Form
      form={form}
      onSubmit={handleSubmit}
      onError={handleError}
      className="relative flex-1 overflow-hidden"
    >
      <Stack spacing={0} h="100%">
        <ScrollArea
          scrollRestore={{ key: 'generation-form' }}
          pt={0}
          className="flex flex-col gap-2 px-3"
        >
          {/* {type === 'remix' && (
              <DismissibleAlert
                id="image-gen-params"
                content="Not all of the resources used in this image are available at this time, we've populated as much of the generation parameters as possible"
              />
            )} */}
          <Group mb={5} spacing={4} noWrap>
            <Input.Label style={{ fontWeight: 590 }} required>
              Model
            </Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 14 }}>
              <Text weight={400}>
                Models are the resources you&apos;re generating with. Using a different base model
                can drastically alter the style and composition of images, while adding additional
                resource can change the characters, concepts and objects
              </Text>
            </InfoPopover>
          </Group>
          <Card
            className={cx(errors.resources && classes.formError)}
            p="sm"
            radius="md"
            withBorder
            sx={{ overflow: 'visible' }}
          >
            <InputResourceSelect
              name="model"
              buttonLabel="Add Model"
              options={{
                canGenerate: true,
                resources: [
                  {
                    type: ModelType.Checkpoint,
                    baseModelSet: hasResources ? baseModel : undefined,
                  },
                ],
              }}
              allowRemove={false}
            />
            <Card.Section className={cx(errors.resources && classes.formError)} mt="sm" withBorder>
              <PersistentAccordion
                storeKey="generation-form-resources"
                classNames={{
                  item: classes.accordionItem,
                  control: classes.accordionControl,
                  content: classes.accordionContent,
                }}
              >
                <Accordion.Item value="resources" sx={{ borderBottom: 0 }}>
                  <Accordion.Control className={cx(errors.resources && classes.formError)}>
                    <Stack spacing={4}>
                      <Group spacing={4}>
                        <Text size="sm" weight={590}>
                          Additional Resources
                        </Text>
                        {additionalResourcesCount > 0 && (
                          <Badge style={{ fontWeight: 590 }}>
                            {additionalResourcesCount}/{limits.resources}
                          </Badge>
                        )}

                        <Button
                          component="span"
                          compact
                          variant="light"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setOpened(true);
                          }}
                          radius="xl"
                          ml="auto"
                          disabled={atLimit}
                        >
                          <Group spacing={4} noWrap>
                            <IconPlus size={16} />
                            <Text size="sm" weight={500}>
                              Add
                            </Text>
                          </Group>
                        </Button>
                      </Group>
                      {atLimit && (!currentUser || currentUser.tier === 'free') && (
                        <Text size="xs">
                          <Link href="/pricing" passHref>
                            <Anchor
                              color="yellow"
                              rel="nofollow"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Become a member
                            </Anchor>
                          </Link>{' '}
                          <Text inherit span>
                            to use more resources at once
                          </Text>
                        </Text>
                      )}
                    </Stack>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <InputResourceSelectMultiple
                      name="resources"
                      limit={limits.resources}
                      buttonLabel="Add additional resource"
                      modalOpened={opened}
                      onCloseModal={() => setOpened(false)}
                      options={{
                        canGenerate: true,
                        resources: getGenerationConfig(baseModel).additionalResourceTypes,
                      }}
                      hideButton
                    />
                  </Accordion.Panel>
                </Accordion.Item>
              </PersistentAccordion>
            </Card.Section>
            {unstableResources.length > 0 && (
              <Card.Section>
                <Alert color="yellow" title="Unstable Resources" radius={0}>
                  <Text size="xs">
                    The following resources are currently unstable and may not be available for
                    generation
                  </Text>
                  <List size="xs">
                    {unstableResources.map((resource) => (
                      <List.Item key={resource.id}>
                        {resource.modelName} - {resource.name}
                      </List.Item>
                    ))}
                  </List>
                </Alert>
              </Card.Section>
            )}
          </Card>

          <Stack spacing={0}>
            <Input.Wrapper
              label={
                <Group mb={5} spacing={4} noWrap>
                  <Input.Label required>Prompt</Input.Label>
                  <InfoPopover size="xs" iconProps={{ size: 14 }}>
                    Type out what you&apos;d like to generate in the prompt, add aspects you&apos;d
                    like to avoid in the negative prompt
                  </InfoPopover>
                </Group>
              }
              error={errors.prompt?.message}
            >
              <Paper
                px="sm"
                sx={(theme) => ({
                  borderBottomLeftRadius: showFillForm ? 0 : undefined,
                  borderBottomRightRadius: showFillForm ? 0 : undefined,
                  borderColor: errors.prompt
                    ? theme.colors.red[theme.fn.primaryShade()]
                    : undefined,
                  marginBottom: errors.prompt ? 5 : undefined,
                  background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : undefined,

                  // Apply focus styles if textarea is focused
                  '&:has(textarea:focus)': {
                    ...theme.focusRingStyles.inputStyles(theme),
                  },
                })}
                withBorder
              >
                <InputTextArea
                  name="prompt"
                  placeholder="Your prompt goes here..."
                  autosize
                  unstyled
                  styles={(theme) => ({
                    input: {
                      background: 'transparent',
                      width: '100%',
                      resize: 'none',
                      border: 'none',
                      padding: '0',
                      outline: 'none',
                      fontFamily: theme.fontFamily,
                      fontSize: theme.fontSizes.sm,
                      lineHeight: theme.lineHeight,
                      overflow: 'hidden',
                      color: theme.colorScheme === 'dark' ? theme.colors.dark[0] : undefined,
                    },
                    // Prevents input from displaying form error
                    error: { display: 'none' },
                    wrapper: { margin: 0 },
                  })}
                  onPaste={(event) => {
                    const text = event.clipboardData.getData('text/plain');
                    if (text) setShowFillForm(text.includes('Steps:'));
                  }}
                  onKeyDown={promptKeyHandler}
                />
                {trainedWords.length > 0 ? (
                  <Stack spacing={8} mb="xs">
                    <Divider />
                    <Text color="dimmed" size="xs" weight={590}>
                      Trigger words
                    </Text>
                    <Group spacing={4}>
                      <TrainedWords
                        type="LORA"
                        trainedWords={trainedWords}
                        badgeProps={{ style: { textTransform: 'none' } }}
                      />
                      <CopyButton value={trainedWords.join(', ')}>
                        {({ copied, copy }) => (
                          <Button
                            variant="subtle"
                            size="xs"
                            color={copied ? 'green' : 'blue.5'}
                            onClick={copy}
                            compact
                          >
                            {copied ? (
                              <Group spacing={4}>
                                Copied <IconCheck size={14} />
                              </Group>
                            ) : (
                              <Group spacing={4}>
                                Copy all <IconCopy size={14} />
                              </Group>
                            )}
                          </Button>
                        )}
                      </CopyButton>
                    </Group>
                  </Stack>
                ) : null}
              </Paper>
            </Input.Wrapper>
            {showFillForm && (
              <Button
                variant="light"
                onClick={handleParsePrompt}
                leftIcon={<IconArrowAutofitDown size={16} />}
                sx={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}
                fullWidth
              >
                Apply Parameters
              </Button>
            )}
          </Stack>

          <InputTextArea
            name="negativePrompt"
            label="Negative Prompt"
            onKeyDown={promptKeyHandler}
            autosize
          />
          <Stack spacing={2}>
            <Input.Label>Aspect Ratio</Input.Label>
            <InputSegmentedControl name="aspectRatio" data={getAspectRatioControls(baseModel)} />
          </Stack>
          <Group position="apart" my="xs">
            <InputSwitch name="nsfw" label="Mature content" labelPosition="left" />
            {features.draftMode && (
              <InputSwitch
                name="draft"
                labelPosition="left"
                label={
                  <Group spacing={4} noWrap pos="relative">
                    <Input.Label>Draft Mode</Input.Label>
                    <Badge
                      color="yellow"
                      size="xs"
                      sx={{ position: 'absolute', right: 18, top: -8, padding: '0 4px' }}
                    >
                      New
                    </Badge>
                    <InfoPopover size="xs" iconProps={{ size: 14 }}>
                      Draft Mode will generate images faster, cheaper, and with slightly less
                      quality. Use this for exploring concepts quickly.
                      <Text size="xs" color="dimmed" mt={4}>
                        Requires generating in batches of 4
                      </Text>
                    </InfoPopover>
                  </Group>
                }
              />
            )}
          </Group>

          <PersistentAccordion
            storeKey="generation-form-advanced"
            variant="contained"
            classNames={{
              item: classes.accordionItem,
              control: classes.accordionControl,
              content: classes.accordionContent,
            }}
          >
            <Accordion.Item value="advanced">
              <Accordion.Control>
                <Text size="sm" weight={590}>
                  Advanced
                </Text>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack>
                  <Stack pos="relative">
                    <LoadingOverlay
                      color={theme.colorScheme === 'dark' ? theme.colors.dark[7] : '#fff'}
                      opacity={0.8}
                      m={-8}
                      radius="md"
                      loader={
                        <Text color="yellow" weight={500}>
                          Not available in Draft Mode
                        </Text>
                      }
                      zIndex={2}
                      visible={!!draft}
                    />
                    <InputNumberSlider
                      name="cfgScale"
                      label={
                        <Group spacing={4} noWrap>
                          <Input.Label>CFG Scale</Input.Label>
                          <InfoPopover size="xs" iconProps={{ size: 14 }}>
                            Controls how closely the image generation follows the text prompt.{' '}
                            <Anchor
                              href="https://wiki.civitai.com/wiki/Classifier_Free_Guidance"
                              target="_blank"
                              rel="nofollow noreferrer"
                              span
                            >
                              Learn more
                            </Anchor>
                            .
                          </InfoPopover>
                        </Group>
                      }
                      min={1}
                      max={isSDXL ? 10 : 30}
                      step={0.5}
                      precision={1}
                      sliderProps={sharedSliderProps}
                      numberProps={sharedNumberProps}
                      presets={[
                        { label: 'Creative', value: '4' },
                        { label: 'Balanced', value: '7' },
                        { label: 'Precise', value: '10' },
                      ]}
                      reverse
                      disabled={cfgDisabled}
                    />
                    <InputSelect
                      name="sampler"
                      disabled={samplerDisabled}
                      label={
                        <Group spacing={4} noWrap>
                          <Input.Label>Sampler</Input.Label>
                          <InfoPopover size="xs" iconProps={{ size: 14 }}>
                            Each will produce a slightly (or significantly) different image result.{' '}
                            <Anchor
                              href="https://wiki.civitai.com/wiki/Sampler"
                              target="_blank"
                              rel="nofollow noreferrer"
                              span
                            >
                              Learn more
                            </Anchor>
                            .
                          </InfoPopover>
                        </Group>
                      }
                      data={generation.samplers}
                      presets={[
                        { label: 'Fast', value: 'Euler a' },
                        { label: 'Popular', value: 'DPM++ 2M Karras' },
                      ]}
                    />
                    <InputNumberSlider
                      name="steps"
                      disabled={stepsDisabled}
                      label={
                        <Group spacing={4} noWrap>
                          <Input.Label>Steps</Input.Label>
                          <InfoPopover size="xs" iconProps={{ size: 14 }}>
                            The number of iterations spent generating an image.{' '}
                            <Anchor
                              href="https://wiki.civitai.com/wiki/Sampling_Steps"
                              target="_blank"
                              rel="nofollow noreferrer"
                              span
                            >
                              Learn more
                            </Anchor>
                            .
                          </InfoPopover>
                        </Group>
                      }
                      min={draft ? 3 : 10}
                      max={draft ? 12 : limits.steps}
                      sliderProps={sharedSliderProps}
                      numberProps={sharedNumberProps}
                      presets={[
                        {
                          label: 'Fast',
                          value: Number(10 + samplerCfgOffset).toString(),
                        },
                        {
                          label: 'Balanced',
                          value: Number(20 + samplerCfgOffset).toString(),
                        },
                        {
                          label: 'High',
                          value: Number(30 + samplerCfgOffset).toString(),
                        },
                      ]}
                      reverse
                    />
                  </Stack>
                  <InputSeed name="seed" label="Seed" min={1} max={generation.maxValues.seed} />
                  {!isSDXL && (
                    <InputNumberSlider
                      name="clipSkip"
                      label="Clip Skip"
                      min={1}
                      max={generation.maxValues.clipSkip}
                      sliderProps={{
                        ...sharedSliderProps,
                        marks: clipSkipMarks,
                      }}
                      numberProps={sharedNumberProps}
                    />
                  )}
                  <InputResourceSelect
                    name="vae"
                    label={
                      <Group spacing={4} noWrap>
                        <Input.Label>{getDisplayName(ModelType.VAE)}</Input.Label>
                        <InfoPopover size="xs" iconProps={{ size: 14 }}>
                          These provide additional color and detail improvements.{' '}
                          <Anchor
                            href="https://wiki.civitai.com/wiki/Variational_Autoencoder"
                            target="_blank"
                            rel="nofollow noreferrer"
                            span
                          >
                            Learn more
                          </Anchor>
                          .
                        </InfoPopover>
                      </Group>
                    }
                    buttonLabel="Add VAE"
                    options={{
                      canGenerate: true,
                      resources: [{ type: ModelType.VAE, baseModelSet: baseModel }],
                    }}
                  />
                  {currentUser?.isModerator && (
                    <InputSwitch name="staging" label="Test Mode" labelPosition="left" />
                  )}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </PersistentAccordion>
          {/* <Card {...sharedCardProps}>
          <Stack>
            <Text>TODO.hires</Text>
          </Stack>
          </Card> */}
        </ScrollArea>
        <div className={cx(classes.generationArea, 'px-2 py-2 flex flex-col gap-2')}>
          <DailyBoostRewardClaim />
          {promptWarning && (
            <div>
              <Alert color="red" title="Prohibited Prompt">
                <Text>{promptWarning}</Text>
                <Button
                  color="red"
                  variant="light"
                  onClick={() => setPromptWarning(null)}
                  style={{ marginTop: 10 }}
                  leftIcon={<IconCheck />}
                  fullWidth
                >
                  I Understand, Continue Generating
                </Button>
              </Alert>
              <Text size="xs" color="dimmed" mt={4}>
                Is this a mistake?{' '}
                <Text
                  component="a"
                  td="underline"
                  href={`https://forms.clickup.com/8459928/f/825mr-9671/KRFFR2BFKJCROV3B8Q?Civitai Username=${currentUser?.username}`}
                  target="_blank"
                >
                  Submit your prompt for review
                </Text>{' '}
                so we can refine our system.
              </Text>
            </div>
          )}
          {status.available && !reviewed ? (
            <Alert color="yellow" title="Image Generation Terms">
              <Text size="xs">
                By using the image generator you confirm that you have read and agree to our{' '}
                <Text component={NextLink} href="/content/tos" td="underline">
                  Terms of Service
                </Text>{' '}
                presented during onboarding. Failure to abide by{' '}
                <Text component={NextLink} href="/content/tos" td="underline">
                  our content policies
                </Text>{' '}
                will result in the loss of your access to the image generator.
              </Text>
              <Button
                color="yellow"
                variant="light"
                onClick={() => setReviewed(true)}
                style={{ marginTop: 10 }}
                leftIcon={<IconCheck />}
                fullWidth
              >
                I Confirm, Start Generating
              </Button>
            </Alert>
          ) : status.available && !promptWarning ? (
            <>
              {status.charge && new Date() < BUZZ_CHARGE_NOTICE_END && (
                <DismissibleAlert id="generator-charge-buzz">
                  <Text>
                    Generating images now costs Buzz.{' '}
                    <Text component={NextLink} href="/articles/4797" td="underline">
                      Learn why
                    </Text>
                  </Text>
                </DismissibleAlert>
              )}

              <QueueSnackbar />
              <Group spacing="xs" className={classes.generateButtonContainer} noWrap>
                <Card withBorder className={classes.generateButtonQuantity} p={0}>
                  <Stack spacing={0}>
                    <Text
                      size="xs"
                      color="dimmed"
                      weight={500}
                      ta="center"
                      className={classes.generateButtonQuantityText}
                    >
                      Quantity
                    </Text>
                    <InputQuantity
                      name="quantity"
                      className={classes.generateButtonQuantityInput}
                    />
                  </Stack>
                </Card>
                {!status.charge ? (
                  <Button
                    type="submit"
                    size="lg"
                    className={classes.generateButtonButton}
                    loading={isLoading}
                    disabled={!canGenerate}
                  >
                    <Text ta="center">Generate</Text>
                  </Button>
                ) : (
                  <BuzzTransactionButton
                    type="submit"
                    size="lg"
                    label="Generate"
                    loading={isCalculatingCost || isLoading}
                    className={classes.generateButtonButton}
                    disabled={disableGenerateButton}
                    buzzAmount={totalCost}
                    showPurchaseModal={false}
                    error={
                      costEstimateError
                        ? 'Error calculating cost. Please try updating your values'
                        : undefined
                    }
                  />
                )}

                <Button
                  onClick={handleClearAll}
                  variant="default"
                  className={classes.generateButtonReset}
                  px="xs"
                >
                  Reset
                </Button>
              </Group>
            </>
          ) : null}
          {status.message && !promptWarning && (
            <AlertWithIcon
              color="yellow"
              title="Image Generation Status Alert"
              icon={<IconAlertTriangle size={20} />}
              iconColor="yellow"
            >
              {status.message}
            </AlertWithIcon>
          )}
        </div>
      </Stack>
    </Form>
  );
};

export const GenerationForm = (args: { onSuccess?: () => void }) => {
  const currentUser = useCurrentUser();

  if (currentUser?.muted)
    return (
      <Center h="100%" w="75%" mx="auto">
        <Stack spacing="xl" align="center">
          <ThemeIcon size="xl" radius="xl" color="yellow">
            <IconLock />
          </ThemeIcon>
          <Text align="center">
            Your account has been restricted due to potential Terms of Service violations, and has
            been flagged for review. A Community Manager will investigate, and you will receive a
            determination notification within 48 hours. You do not need to contact us.
          </Text>
        </Stack>
      </Center>
    );

  return (
    <IsClient>
      <GenerationFormInner {...args} />
    </IsClient>
  );
};

const useStyles = createStyles((theme) => ({
  generationContainer: {},
  generationArea: {
    borderRadius: theme.radius.md,
    boxShadow: `inset 0 2px ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
    }`,
  },
  generateButtonContainer: {
    width: '100%',
    justifyContent: 'stretch',
    alignItems: 'stretch',
  },
  generateButtonQuantity: {
    width: 100,
    // borderTopRightRadius: 0,
    // borderBottomRightRadius: 0,
  },
  generateButtonQuantityText: {
    paddingRight: 25,
  },
  generateButtonQuantityInput: {
    marginTop: -20,
    input: {
      background: 'transparent',
      border: 'none',
      borderTopRightRadius: 0,
      borderBottomRightRadius: 0,
      borderTopLeftRadius: 0,
      textAlign: 'center',
      paddingRight: 25 + 12,
      paddingTop: 18,
      paddingBottom: 6,
      lineHeight: 1,
      fontWeight: 500,
      height: 'auto',
    },
  },
  generateButtonButton: {
    flex: 1,
    // borderRadius: 0,
    height: 'auto',
  },

  generateButtonReset: {
    // borderBottomLeftRadius: 0,
    // borderTopLeftRadius: 0,
    height: 'auto',
  },

  generateButtonRandom: {
    borderRadius: 0,
    height: 'auto',
    order: 3,
  },
  promptInputLabel: {
    display: 'inline-flex',
    gap: 4,
    marginBottom: 5,
    alignItems: 'center',
  },
  accordionItem: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : '#fff',

    '&:first-of-type': {
      borderTopLeftRadius: '8px',
      borderTopRightRadius: '8px',
    },

    '&:last-of-type': {
      borderBottomLeftRadius: '8px',
      borderBottomRightRadius: '8px',
    },

    '&[data-active]': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : `#fff`,
    },
  },
  accordionControl: {
    padding: '8px 8px 8px 12px',

    '&:hover': {
      background: 'transparent',
    },

    '&[data-active]': {
      borderRadius: '0 !important',
      borderBottom: `1px solid ${
        theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
      }`,
    },
  },
  accordionContent: {
    padding: '8px 12px 12px 12px',
  },
  formError: {
    borderColor: theme.colors.red[theme.fn.primaryShade()],
    color: theme.colors.red[theme.fn.primaryShade()],
  },
}));

const sharedSliderProps: SliderProps = {
  size: 'sm',
};

const sharedNumberProps: NumberInputProps = {
  size: 'sm',
};

const getAspectRatioControls = (baseModel?: string) => {
  const aspectRatios = getGenerationConfig(baseModel).aspectRatios;
  return aspectRatios.map(({ label, width, height }, index) => ({
    label: (
      <Stack spacing={2}>
        <Center>
          <Paper
            withBorder
            sx={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 20 }}
          />
        </Center>
        <Stack spacing={0}>
          <Text size="xs">{label}</Text>
          <Text size={10} color="dimmed">{`${width}x${height}`}</Text>
        </Stack>
      </Stack>
    ),
    value: `${index}`,
  }));
};

const clipSkipMarks = Array(10)
  .fill(0)
  .map((_, index) => ({ value: index + 1 }));
