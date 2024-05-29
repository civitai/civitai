import {
  Alert,
  Button,
  Card,
  Center,
  Input,
  NumberInputProps,
  Paper,
  SliderProps,
  Stack,
  Text,
  createStyles,
  List,
  Accordion,
  Anchor,
  Badge,
  Divider,
  useMantineTheme,
  LoadingOverlay,
} from '@mantine/core';
import { DeepPartial, useWatch } from 'react-hook-form';
import { getHotkeyHandler, useLocalStorage } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { ModelType } from '@prisma/client';
import { IconPlus } from '@tabler/icons-react';
import { IconArrowAutofitDown } from '@tabler/icons-react';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { TypeOf, z } from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import InputQuantity from '~/components/ImageGeneration/GenerationForm/InputQuantity';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import InputResourceSelect from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import InputResourceSelectMultiple from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import {
  keyupEditAttention,
  useGenerationStatus,
  useUnstableResources,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { useSubmitTextToImageRequest } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { useLoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { PersistentAccordion } from '~/components/PersistentAccordion/PersistantAccordion';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  Form,
  InputNumberSlider,
  InputSegmentedControl,
  InputSwitch,
  InputTextArea,
  InputSelect,
} from '~/libs/form';
import { Watch } from '~/libs/form/components/Watch';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  BaseModel,
  draftMode,
  generation,
  getGenerationConfig,
  samplerOffsets,
} from '~/server/common/constants';
import {
  GetGenerationDataInput,
  blockedRequest,
  defaultsByTier,
} from '~/server/schema/generation.schema';
import { imageGenerationSchema, imageSchema } from '~/server/schema/image.schema';
import {
  textToImageParamsSchema,
  textToImageResourceSchema,
  textToImageWhatIfSchema,
} from '~/server/schema/orchestrator/textToImage.schema';
import { userTierSchema } from '~/server/schema/user.schema';
import { GenerationData } from '~/server/services/generation/generation.service';
import { getBaseModelSetType, getIsSdxl } from '~/shared/constants/generation.constants';
import { generationPanel } from '~/store/generation.store';
import { parsePromptMetadata } from '~/utils/metadata';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import {
  GenerationFormOutput,
  useGenerationForm,
} from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';

// #region [form component]
export function GenerationForm2() {
  const theme = useMantineTheme();
  const { classes, cx } = useStyles();
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { requireLogin } = useLoginRedirect({ reason: 'image-gen', returnUrl: '/generate' });
  const status = useGenerationStatus();

  const form = useGenerationForm();

  useEffect(() => {
    const subscription = form.watch((watchedValues, { name }) => {
      if (
        name !== 'baseModel' &&
        watchedValues.model &&
        getBaseModelSetType(watchedValues.model.baseModel) !== watchedValues.baseModel
      ) {
        form.setValue('baseModel', getBaseModelSetType(watchedValues.model.baseModel));
      }
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const { unstableResources: allUnstableResources } = useUnstableResources();
  const [opened, setOpened] = useState(false);
  const [promptWarning, setPromptWarning] = useState<string | null>(null);
  const [reviewed, setReviewed] = useLocalStorage({
    key: 'review-generation-terms',
    defaultValue: window?.localStorage?.getItem('review-generation-terms') === 'true',
  });

  const { errors } = form.formState;

  function clearWarning() {
    setPromptWarning(null);
  }

  function handleReset() {
    form.reset();
    clearWarning();
  }

  // #region [handle parse prompt]
  const [showFillForm, setShowFillForm] = useState(false);
  async function handleParsePrompt() {
    const prompt = form.getValues('prompt');
    const metadata = parsePromptMetadata(prompt);
    const result = imageGenerationSchema.safeParse(metadata);
    if (result.success) {
      form.setValues(result.data);
      setShowFillForm(false);
    } else {
      console.error(result.error);
      showErrorNotification({
        title: 'Unable to parse prompt',
        error: new Error('We are unable to fill out the form with the provided prompt.'),
      });
    }
  }
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
    ``,
  ]);

  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const { mutateAsync, isLoading } = useSubmitTextToImageRequest();
  function handleSubmit(data: GenerationFormOutput) {
    if (!currentUser) {
      requireLogin();
      generationPanel.close();
      return;
    }

    const { model, resources: additionalResources, vae, cost, ...params } = data;
    const resources = [model, ...additionalResources, vae]
      .filter(isDefined)
      .filter((x) => x.covered !== false);

    async function performTransaction() {
      if (!params.baseModel) throw new Error('could not find base model');
      try {
        await mutateAsync({ resources, params });
      } catch (e) {
        const error = e as Error;
        if (error.message.startsWith('Your prompt was flagged')) {
          setPromptWarning(error.message + '. Continued attempts will result in an automated ban.');
          currentUser?.refresh();
        }
      }
    }

    setPromptWarning(null);
    conditionalPerformTransaction(cost, performTransaction);
  }

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

  return (
    <Form
      form={form}
      onSubmit={handleSubmit}
      onError={handleError}
      className="relative flex h-full flex-1 flex-col overflow-hidden"
    >
      <ScrollArea
        scrollRestore={{ key: 'generation-form' }}
        pt={0}
        className="flex flex-col gap-2 px-3"
      >
        <div className="mb-1 flex items-center gap-1">
          <Input.Label style={{ fontWeight: 590 }} required>
            Model
          </Input.Label>
          <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
            <Text weight={400}>
              Models are the resources you&apos;re generating with. Using a different base model can
              drastically alter the style and composition of images, while adding additional
              resource can change the characters, concepts and objects
            </Text>
          </InfoPopover>
        </div>
        <Card
          className={cx({ [classes.formError]: form.formState.errors.resources })}
          withBorder
          p="sm"
          radius="md"
          pb={0}
        >
          <Watch {...form} fields={['baseModel', 'model', 'resources', 'vae']}>
            {({ baseModel, model, resources = [], vae }) => {
              const selectedResources = [...resources, vae, model].filter(isDefined);
              const unstableResources = selectedResources.filter((x) =>
                allUnstableResources.includes(x.id)
              );
              const atLimit = resources.length >= status.limits.resources;

              return (
                <>
                  <InputResourceSelect
                    name="model"
                    buttonLabel="Add Model"
                    allowRemove={false}
                    options={{
                      canGenerate: true,
                      resources: [
                        {
                          type: ModelType.Checkpoint,
                          baseModelSet: !!resources?.length || !!vae ? baseModel : undefined,
                        },
                      ],
                    }}
                  />
                  <Card.Section
                    className={cx(
                      { [classes.formError]: form.formState.errors.resources },
                      'border-b-0 mt-3'
                    )}
                    withBorder
                  >
                    <PersistentAccordion
                      storeKey="generation-form-resources"
                      classNames={{
                        item: classes.accordionItem,
                        control: classes.accordionControl,
                        content: classes.accordionContent,
                      }}
                    >
                      <Accordion.Item value="resources" className="border-b-0">
                        <Accordion.Control
                          className={cx({ [classes.formError]: form.formState.errors.resources })}
                        >
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1">
                              <Text size="sm" weight={590}>
                                Additional Resources
                              </Text>
                              {resources.length > 0 && (
                                <Badge className="font-semibold">
                                  {resources.length}/{status.limits.resources}
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
                                classNames={{ inner: 'flex gap-1' }}
                              >
                                <IconPlus size={16} />
                                <Text size="sm" weight={500}>
                                  Add
                                </Text>
                              </Button>
                            </div>

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
                          </div>
                        </Accordion.Control>
                        <Accordion.Panel>
                          <InputResourceSelectMultiple
                            name="resources"
                            limit={status.limits.resources}
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
                          The following resources are currently unstable and may not be available
                          for generation
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
                </>
              );
            }}
          </Watch>
        </Card>

        <div className="flex flex-col">
          <Input.Wrapper
            label={
              <div className="mb-1 flex items-center gap-1">
                <Input.Label required>Prompt</Input.Label>
                <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                  Type out what you&apos;d like to generate in the prompt, add aspects you&apos;d
                  like to avoid in the negative prompt
                </InfoPopover>
              </div>
            }
            error={errors.prompt?.message}
          >
            <Watch {...form} fields={['resources']}>
              {({ resources = [] }) => {
                const trainedWords = resources.flatMap((x) => x.trainedWords).filter(isDefined);

                return (
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
                      <div className="mb-1 flex flex-col gap-2">
                        <Divider />
                        <Text color="dimmed" className="text-xs font-semibold">
                          Trigger words
                        </Text>
                        <div className="flex items-center gap-1">
                          <TrainedWords
                            type="LORA"
                            trainedWords={trainedWords}
                            badgeProps={{ style: { textTransform: 'none' } }}
                          />
                          <CopyButton value={trainedWords.join(', ')}>
                            {({ copied, copy, Icon, color }) => (
                              <Button
                                variant="subtle"
                                size="xs"
                                color={color ?? 'blue.5'}
                                onClick={copy}
                                compact
                                classNames={{ inner: 'flex gap-1' }}
                              >
                                {copied ? 'Copied' : 'Copy All'} <Icon size={14} />
                              </Button>
                            )}
                          </CopyButton>
                        </div>
                      </div>
                    ) : null}
                  </Paper>
                );
              }}
            </Watch>
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
        </div>

        <InputTextArea
          name="negativePrompt"
          label="Negative Prompt"
          onKeyDown={promptKeyHandler}
          autosize
        />

        <div className="flex flex-col gap-0.5">
          <Input.Label>Aspect Ratio</Input.Label>
          <Watch {...form} fields={['baseModel']}>
            {({ baseModel }) => (
              <InputSegmentedControl name="aspectRatio" data={getAspectRatioControls(baseModel)} />
            )}
          </Watch>
        </div>

        <div className="my-2 flex justify-between">
          <InputSwitch name="nsfw" label="Mature content" labelPosition="left" />
          {features.draftMode && (
            <InputSwitch
              name="draft"
              labelPosition="left"
              label={
                <div className="relative flex items-center gap-1">
                  <Input.Label>Draft Mode</Input.Label>
                  <Badge
                    color="yellow"
                    size="xs"
                    sx={{ position: 'absolute', right: 18, top: -8, padding: '0 4px' }}
                  >
                    New
                  </Badge>
                  <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                    Draft Mode will generate images faster, cheaper, and with slightly less quality.
                    Use this for exploring concepts quickly.
                    <Text size="xs" color="dimmed" mt={4}>
                      Requires generating in batches of 4
                    </Text>
                  </InfoPopover>
                </div>
              }
            />
          )}
        </div>

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
              <div className="flex flex-col gap-3">
                <Watch {...form} fields={['draft', 'baseModel']}>
                  {({ draft, baseModel }) => {
                    const cfgDisabled = !!draft;
                    const samplerDisabled = !!draft;
                    const stepsDisabled = !!draft;
                    const isSDXL = getIsSdxl(baseModel);

                    return (
                      <div className="relative flex flex-col gap-3">
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
                            <div className="flex items-center gap-1">
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
                            </div>
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
                            <div className="flex items-center gap-1">
                              <Input.Label>Sampler</Input.Label>
                              <InfoPopover size="xs" iconProps={{ size: 14 }}>
                                Each will produce a slightly (or significantly) different image
                                result.{' '}
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
                            </div>
                          }
                          data={generation.samplers}
                          presets={[
                            { label: 'Fast', value: 'Euler a' },
                            { label: 'Popular', value: 'DPM++ 2M Karras' },
                          ]}
                        />
                        <Watch {...form} fields={['cfgScale', 'sampler']}>
                          {({ cfgScale, sampler }) => {
                            const castedSampler = sampler as keyof typeof samplerOffsets;
                            const samplerOffset = samplerOffsets[castedSampler] ?? 0;
                            const cfgOffset = Math.max((cfgScale ?? 0) - 4, 0) * 2;
                            const samplerCfgOffset = samplerOffset + cfgOffset;

                            return (
                              <InputNumberSlider
                                name="steps"
                                disabled={stepsDisabled}
                                label={
                                  <div className="flex items-center gap-1">
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
                                  </div>
                                }
                                min={draft ? 3 : 10}
                                max={draft ? 12 : status.limits.steps}
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
                            );
                          }}
                        </Watch>
                      </div>
                    );
                  }}
                </Watch>
                <InputSeed name="seed" label="Seed" min={1} max={generation.maxValues.seed} />
                <Watch {...form} fields={['baseModel']}>
                  {({ baseModel }) => {
                    const isSDXL = getIsSdxl(baseModel);

                    return (
                      <>
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
                            <div className="flex items-center gap-1">
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
                            </div>
                          }
                          buttonLabel="Add VAE"
                          options={{
                            canGenerate: true,
                            resources: [{ type: ModelType.VAE, baseModelSet: baseModel }],
                          }}
                        />
                      </>
                    );
                  }}
                </Watch>

                {currentUser?.isModerator && (
                  <InputSwitch name="staging" label="Test Mode" labelPosition="left" />
                )}
              </div>
            </Accordion.Panel>
          </Accordion.Item>
        </PersistentAccordion>
      </ScrollArea>
      <div className="shadow-topper flex flex-col gap-2 rounded-xl p-2">
        <DailyBoostRewardClaim />
        {promptWarning ? (
          <div>
            <Alert color="red" title="Prohibited Prompt">
              <Text>{promptWarning}</Text>
              <Button
                color="red"
                variant="light"
                onClick={clearWarning}
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
        ) : !status.available ? (
          <AlertWithIcon
            color="yellow"
            title="Image Generation Status Alert"
            icon={<IconAlertTriangle size={20} />}
            iconColor="yellow"
          >
            {status.message}
          </AlertWithIcon>
        ) : (
          <>
            {!reviewed && (
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
            )}
            <QueueSnackbar />
            <div className="flex gap-2">
              <Card withBorder className="flex max-w-24 flex-1 flex-col p-0">
                <Text className="pr-6 text-center text-xs font-semibold" color="dimmed">
                  Quantity
                </Text>
                <InputQuantity name="quantity" className={classes.generateButtonQuantityInput} />
              </Card>
              <SubmitButton isLoading={isLoading} />
              <Button onClick={handleReset} variant="default" className="h-auto px-3">
                Reset
              </Button>
            </div>
          </>
        )}
      </div>
    </Form>
  );
}
// #endregion

function SubmitButton(props: { isLoading?: boolean }) {
  const status = useGenerationStatus();
  const canGenerate = useGenerationContext((state) => state.canGenerate);
  const form = useGenerationForm();
  const { model, resources = [], vae, ...params } = useWatch({ control: form.control });
  const query = textToImageWhatIfSchema.safeParse({
    ...params,
    prompt: '',
    negativePrompt: '',
    resources: [model, ...resources, vae].map((x) => (x ? x.id : undefined)).filter(isDefined),
  });

  const { data, isLoading, isError } = trpc.orchestrator.textToImageWhatIf.useQuery(
    query.success ? query.data : ({} as any),
    {
      enabled: query.success,
    }
  );

  useEffect(() => {
    if (data) form.setValue('cost', data.cost);
  }, [data?.cost]); // eslint-disable-line

  return !status.charge ? (
    <Button
      type="submit"
      size="lg"
      className="h-auto flex-1"
      loading={props.isLoading}
      disabled={!canGenerate}
    >
      <Text ta="center">Generate</Text>
    </Button>
  ) : (
    <BuzzTransactionButton
      type="submit"
      size="lg"
      label="Generate"
      loading={isLoading || props.isLoading}
      className="h-auto flex-1"
      disabled={!canGenerate || !data}
      buzzAmount={data?.cost ?? 0}
      showPurchaseModal={false}
      error={
        !isLoading && isError
          ? 'Error calculating cost. Please try updating your values'
          : undefined
      }
    />
  );
}

// #region [styles]
const useStyles = createStyles((theme) => ({
  generateButtonQuantityInput: {
    marginTop: -16,
    input: {
      background: 'transparent',
      border: 'none',
      borderTopRightRadius: 0,
      borderBottomRightRadius: 0,
      borderTopLeftRadius: 0,
      textAlign: 'center',
      paddingRight: 25 + 12,
      paddingTop: 22,
      paddingBottom: 6,
      lineHeight: 1,
      fontWeight: 500,
      height: 'auto',
    },
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
// #endregion

// #region [misc]
const sharedSliderProps: SliderProps = {
  size: 'sm',
};

const sharedNumberProps: NumberInputProps = {
  size: 'sm',
};

const getAspectRatioControls = (baseModel?: string) => {
  const aspectRatios = getGenerationConfig(baseModel).aspectRatios;
  console.log({ baseModel, aspectRatios });
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
// #endregion
