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
  ActionIcon,
  Group,
  SegmentedControl,
} from '@mantine/core';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { hashify, parseAIR } from '~/utils/string-helpers';
import { getHotkeyHandler, useLocalStorage } from '@mantine/hooks';
import { ModelType } from '@prisma/client';
import { IconInfoCircle, IconPlus, IconX } from '@tabler/icons-react';
import { IconArrowAutofitDown } from '@tabler/icons-react';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
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
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { useSubmitCreateImage } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { PersistentAccordion } from '~/components/PersistentAccordion/PersistantAccordion';
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
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { generation, getGenerationConfig, samplerOffsets } from '~/server/common/constants';
import { imageGenerationSchema } from '~/server/schema/image.schema';
import {
  fluxModeOptions,
  getBaseModelResourceTypes,
  getIsFlux,
  getIsSD3,
  getIsSdxl,
  getWorkflowDefinitionFeatures,
  sanitizeParamsByWorkflowDefinition,
} from '~/shared/constants/generation.constants';
import { parsePromptMetadata } from '~/utils/metadata';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import {
  GenerationFormOutput,
  useGenerationForm,
  blockedRequest,
} from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import React, { useEffect, useState, useMemo } from 'react';
import { create } from 'zustand';
import { useTextToImageWhatIfContext } from '~/components/ImageGeneration/GenerationForm/TextToImageWhatIfProvider';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { clone } from 'lodash-es';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { RefreshSessionButton } from '~/components/RefreshSessionButton/RefreshSessionButton';
import { useTipStore } from '~/store/tip.store';

const useCostStore = create<{ cost?: number }>(() => ({}));

// #region [form component]
export function GenerationFormContent() {
  const { classes, cx, theme } = useStyles();
  const featureFlags = useFeatureFlags();
  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : null),
    [status.message]
  );

  const form = useGenerationForm();

  const { unstableResources: allUnstableResources } = useUnstableResources();
  const [opened, setOpened] = useState(false);
  const [promptWarning, setPromptWarning] = useState<string | null>(null);
  const [reviewed, setReviewed] = useLocalStorage({
    key: 'review-generation-terms',
    defaultValue: window?.localStorage?.getItem('review-generation-terms') === 'true',
  });
  const { subscription, meta: subscriptionMeta } = useActiveSubscription();

  const { data: workflowDefinitions, isLoading: loadingWorkflows } =
    trpc.generation.getWorkflowDefinitions.useQuery();

  const [workflow, image] = form.watch(['workflow', 'image']) ?? 'txt2img';
  const workflowDefinition = workflowDefinitions?.find((x) => x.key === workflow);

  const features = getWorkflowDefinitionFeatures(workflowDefinition);
  features.draft = features.draft && featureFlags.draftMode;
  const subscriptionMismatch = subscription ? subscriptionMeta?.tier !== status.tier : false;

  const { errors } = form.formState;

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.markers,
    setFilters: state.setMarkerFilters,
  }));

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
  ]);

  const { conditionalPerformTransaction } = useBuzzTransaction({
    type: 'Generation',
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const { mutateAsync, isLoading } = useSubmitCreateImage();
  function handleSubmit(data: GenerationFormOutput) {
    if (isLoading) return;
    const { cost = 0 } = useCostStore.getState();
    const tips = useTipStore.getState();
    let creatorTip = tips.creatorTip;
    const civitaiTip = tips.civitaiTip;

    const {
      model,
      resources: additionalResources,
      vae,
      remixOfId,
      remixSimilarity,
      aspectRatio,
      upscaleHeight,
      upscaleWidth,
      ...params
    } = data;
    sanitizeParamsByWorkflowDefinition(params, workflowDefinition);
    const modelClone = clone(model);

    const isFlux = getIsFlux(params.baseModel);
    if (isFlux) {
      if (additionalResources.length === 0) creatorTip = 0;
      if (params.fluxMode) {
        const { version } = parseAIR(params.fluxMode);
        modelClone.id = version;
      }
    }
    const isSD3 = getIsSD3(params.baseModel);
    if (isSD3) {
      if (additionalResources.length === 0) creatorTip = 0;
    }

    const resources = [modelClone, ...additionalResources, vae]
      .filter(isDefined)
      .filter((x) => x.available !== false);

    async function performTransaction() {
      if (!params.baseModel) throw new Error('could not find base model');
      try {
        await mutateAsync({
          resources,
          params: {
            ...params,
            nsfw: hasMinorResources || !featureFlags.canViewNsfw ? false : params.nsfw,
          },
          tips: featureFlags.creatorComp
            ? { creators: creatorTip, civitai: civitaiTip }
            : undefined,
          remixOfId: remixSimilarity && remixSimilarity > 0.75 ? remixOfId : undefined,
        });
      } catch (e) {
        const error = e as Error;
        if (error.message.startsWith('Your prompt was flagged')) {
          setPromptWarning(error.message + '. Continued attempts will result in an automated ban.');
          currentUser?.refresh();
        }
      }
    }

    setPromptWarning(null);
    const totalCost = cost + creatorTip * cost + civitaiTip * cost;
    conditionalPerformTransaction(totalCost, performTransaction);

    if (filters.marker) {
      setFilters({ marker: undefined });
    }
  }

  const { mutateAsync: reportProhibitedRequest } = trpc.user.reportProhibitedRequest.useMutation();
  const handleError = async (e: unknown) => {
    const promptError = (e as any)?.prompt as any;
    if (promptError?.type === 'custom') {
      const status = blockedRequest.status();
      setPromptWarning(promptError.message);
      if (status === 'notified' || status === 'muted') {
        const { prompt, negativePrompt } = form.getValues();
        const isBlocked = await reportProhibitedRequest({ prompt, negativePrompt });
        if (isBlocked) currentUser?.refresh();
      }
    } else {
      setPromptWarning(null);
    }
  };

  const [hasMinorResources, setHasMinorResources] = useState(false);
  useEffect(() => {
    const subscription = form.watch(({ model, resources = [], vae }, { name }) => {
      if (name === 'model' || name === 'resources' || name === 'vae') {
        setHasMinorResources([model, ...resources, vae].filter((x) => x?.minor).length > 0);
      }
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []);

  return (
    <Form
      form={form}
      onSubmit={handleSubmit}
      onError={handleError}
      className="relative flex flex-1 flex-col justify-between gap-2"
    >
      <Watch {...form} fields={['baseModel', 'fluxMode', 'draft', 'model']}>
        {({ baseModel, fluxMode, draft, model }) => {
          const isSDXL = getIsSdxl(baseModel);
          const isFlux = getIsFlux(baseModel);
          const isSD3 = getIsSD3(baseModel);
          const isDraft = isFlux
            ? fluxMode === 'urn:air:flux1:checkpoint:civitai:618692@699279'
            : isSD3
            ? model.id === 983611
            : features.draft && !!draft;
          const cfgDisabled = isDraft;
          const samplerDisabled = isDraft;
          const stepsDisabled = isDraft;
          let stepsMin = isDraft ? 3 : 10;
          let stepsMax = isDraft ? 12 : status.limits.steps;
          if (isFlux || isSD3) {
            stepsMin = isDraft ? 4 : 20;
            stepsMax = isDraft ? 4 : 50;
          }
          let cfgScaleMin = 1;
          let cfgScaleMax = isSDXL ? 10 : 30;
          if (isFlux || isSD3) {
            cfgScaleMin = isDraft ? 1 : 2;
            cfgScaleMax = isDraft ? 1 : 20;
          }

          const resourceTypes = getBaseModelResourceTypes(baseModel);
          if (!resourceTypes) return <></>;

          return (
            <>
              <div className="flex flex-col gap-2 px-3">
                {!isFlux && !isSD3 && (
                  <div className="flex items-start justify-start gap-3">
                    {features.image && image && (
                      <div className="relative mt-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={image}
                          alt="image to refine"
                          className="max-w-16 rounded-md shadow-sm shadow-black"
                        />
                        <ActionIcon
                          variant="light"
                          size="sm"
                          color="red"
                          radius="xl"
                          className="absolute -right-2 -top-2"
                          onClick={() => form.setValue('image', undefined)}
                        >
                          <IconX size={16} strokeWidth={2.5} />
                        </ActionIcon>
                      </div>
                    )}
                    <div className="flex-1">
                      <InputSelect
                        label={
                          <div className="flex items-center gap-1">
                            <Input.Label>Workflow</Input.Label>
                            <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                              Go beyond text-to-image with different workflows. Currently we have
                              limited workflows that cover some of the most important use cases.
                              Community workflows coming soon.
                            </InfoPopover>
                            <Badge color="yellow" size="xs">
                              New
                            </Badge>
                          </div>
                        }
                        // label={workflowDefinition?.type === 'img2img' ? 'Image-to-image workflow' : 'Workflow'}
                        className="flex-1"
                        name="workflow"
                        data={
                          workflowDefinitions
                            ?.filter(
                              (x) => x.type === workflowDefinition?.type && x.selectable !== false
                            )
                            .map(({ key, label }) => ({ label, value: key })) ?? []
                        }
                        loading={loadingWorkflows}
                      />
                      {workflowDefinition?.description && (
                        <Text size="xs" lh={1.2} color="dimmed" className="my-2">
                          {workflowDefinition.description}
                        </Text>
                      )}
                    </div>
                  </div>
                )}

                <div className="-mb-1 flex items-center gap-1">
                  <Input.Label style={{ fontWeight: 590 }} required>
                    Model
                  </Input.Label>
                  <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                    <Text weight={400}>
                      Models are the resources you&apos;re generating with. Using a different base
                      model can drastically alter the style and composition of images, while adding
                      additional resource can change the characters, concepts and objects
                    </Text>
                  </InfoPopover>
                </div>

                <Watch {...form} fields={['model', 'resources', 'vae']}>
                  {({ model, resources = [], vae }) => {
                    const selectedResources = [...resources, vae, model].filter(isDefined);
                    const minorFlaggedResources = selectedResources.filter((x) => x.minor);
                    const unstableResources = selectedResources.filter((x) =>
                      allUnstableResources.includes(x.id)
                    );
                    const atLimit = resources.length >= status.limits.resources;

                    return (
                      <Card
                        className={cx(
                          { [classes.formError]: form.formState.errors.resources },
                          'overflow-visible'
                        )}
                        withBorder
                        p="sm"
                        radius="sm"
                      >
                        <InputResourceSelect
                          name="model"
                          buttonLabel="Add Model"
                          allowRemove={false}
                          options={{
                            canGenerate: true,
                            resources: resourceTypes
                              .filter((x) => x.type === 'Checkpoint')
                              .map(({ type, baseModels }) => ({
                                type,
                                baseModels: !!resources?.length || !!vae ? baseModels : undefined,
                              })), // TODO - needs to be able to work when no resources selected (baseModels should be empty array)
                          }}
                          hideVersion={isFlux}
                          pb={
                            unstableResources.length || minorFlaggedResources.length
                              ? 'sm'
                              : undefined
                          }
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
                                className={cx({
                                  [classes.formError]: form.formState.errors.resources,
                                })}
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
                                      <Link legacyBehavior href="/pricing" passHref>
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
                                    resources: resourceTypes.filter(
                                      (x) => x.type !== 'VAE' && x.type !== 'Checkpoint'
                                    ),
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
                                The following resources are currently unstable and may not be
                                available for generation
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
                        {minorFlaggedResources.length > 0 && (
                          <Card.Section>
                            <Alert color="yellow" title="Mature Content Restricted" radius={0}>
                              <Text size="xs">
                                {`A resource you selected does not allow the generation of Mature Content.
                    If you attempt to generate mature content with this resource,
                    the image will not be returned but you `}
                                <Text span italic inherit>
                                  will
                                </Text>
                                {` be charged Buzz.`}
                              </Text>{' '}
                              <List size="xs">
                                {minorFlaggedResources.map((resource) => (
                                  <List.Item key={resource.id}>
                                    {resource.modelName} - {resource.name}
                                  </List.Item>
                                ))}
                              </List>
                            </Alert>
                          </Card.Section>
                        )}
                        {!isFlux && !isSD3 && <ReadySection />}
                      </Card>
                    );
                  }}
                </Watch>

                {isSD3 && (
                  <Alert className="overflow-visible">
                    This is an experimental build, as such pricing and results are subject to change
                  </Alert>
                )}

                {isFlux && (
                  <Watch {...form} fields={['resources']}>
                    {({ resources }) => (
                      <div className="flex flex-col gap-0.5">
                        <Input.Label className="flex items-center gap-1">
                          Model Mode{' '}
                          <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                            {`Flux comes with 3 model variants: Schnell, Dev, and Pro. We've
                       choosen names that we believe best align with their purpose.`}
                          </InfoPopover>
                        </Input.Label>
                        <InputSegmentedControl
                          name="fluxMode"
                          data={fluxModeOptions}
                          disabled={!!resources?.length}
                        />
                      </div>
                    )}
                  </Watch>
                )}

                <div className="flex flex-col">
                  <Input.Wrapper
                    label={
                      <div className="mb-1 flex items-center gap-1">
                        <Input.Label required>Prompt</Input.Label>
                        <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                          Type out what you&apos;d like to generate in the prompt, add aspects
                          you&apos;d like to avoid in the negative prompt
                        </InfoPopover>
                      </div>
                    }
                    error={errors.prompt?.message}
                  >
                    <Watch {...form} fields={['resources']}>
                      {({ resources = [] }) => {
                        const trainedWords = resources
                          .flatMap((x) => x.trainedWords)
                          .filter(isDefined);

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
                              background:
                                theme.colorScheme === 'dark' ? theme.colors.dark[6] : undefined,

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
                                  color:
                                    theme.colorScheme === 'dark' ? theme.colors.dark[0] : undefined,
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
                                <div className="mb-2 flex items-center gap-1">
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

                {!isFlux && (
                  <InputTextArea
                    name="negativePrompt"
                    label="Negative Prompt"
                    onKeyDown={promptKeyHandler}
                    autosize
                  />
                )}

                <div className="flex flex-col gap-0.5">
                  <Input.Label>Aspect Ratio</Input.Label>
                  <InputSegmentedControl
                    name="aspectRatio"
                    data={getAspectRatioControls(baseModel)}
                  />
                </div>

                {!isFlux && !isSD3 && featureFlags.canViewNsfw && (
                  <div className="my-2 flex flex-wrap justify-between gap-3">
                    <InputSwitch
                      name="nsfw"
                      label="Mature content"
                      labelPosition="left"
                      disabled={hasMinorResources}
                      checked={hasMinorResources ? false : undefined}
                    />
                    {features.draft && (
                      <InputSwitch
                        name="draft"
                        labelPosition="left"
                        label={
                          <div className="relative flex items-center gap-1">
                            <Input.Label>Draft Mode</Input.Label>
                            <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                              Draft Mode will generate images faster, cheaper, and with slightly
                              less quality. Use this for exploring concepts quickly.
                              <Text size="xs" color="dimmed" mt={4}>
                                Requires generating in batches of 4
                              </Text>
                            </InfoPopover>
                          </div>
                        }
                      />
                    )}
                    {/* {featureFlags.experimentalGen && (
                      <InputSwitch name="experimental" label="Experimental" labelPosition="left" />
                    )} */}
                  </div>
                )}

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
                        {!isDraft && (
                          <div className="relative flex flex-col gap-3">
                            {/* <LoadingOverlay
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
                            visible={isDraft}
                          /> */}
                            <InputNumberSlider
                              name="cfgScale"
                              label={
                                <div className="flex items-center gap-1">
                                  <Input.Label>CFG Scale</Input.Label>
                                  <InfoPopover size="xs" iconProps={{ size: 14 }}>
                                    Controls how closely the image generation follows the text
                                    prompt.{' '}
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
                              min={cfgScaleMin}
                              max={cfgScaleMax}
                              step={0.5}
                              precision={1}
                              sliderProps={sharedSliderProps}
                              numberProps={sharedNumberProps}
                              presets={
                                isFlux || isSD3
                                  ? undefined
                                  : [
                                      { label: 'Creative', value: '4' },
                                      { label: 'Balanced', value: '7' },
                                      { label: 'Precise', value: '10' },
                                    ]
                              }
                              reverse
                              disabled={cfgDisabled}
                            />
                            {!isFlux && !isSD3 && (
                              <InputSelect
                                name="sampler"
                                disabled={samplerDisabled}
                                label={
                                  <div className="flex items-center gap-1">
                                    <Input.Label>Sampler</Input.Label>
                                    <InfoPopover size="xs" iconProps={{ size: 14 }}>
                                      Each will produce a slightly (or significantly) different
                                      image result.{' '}
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
                            )}
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
                                    min={stepsMin}
                                    max={stepsMax}
                                    sliderProps={sharedSliderProps}
                                    numberProps={sharedNumberProps}
                                    presets={
                                      isFlux || isSD3
                                        ? undefined
                                        : [
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
                                          ]
                                    }
                                    reverse
                                  />
                                );
                              }}
                            </Watch>
                          </div>
                        )}
                        <InputSeed name="seed" label="Seed" />
                        {!isSDXL && !isFlux && !isSD3 && (
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
                        {features.denoise && (
                          <InputNumberSlider
                            name="denoise"
                            label="Denoise"
                            min={0}
                            max={0.75}
                            step={0.05}
                          />
                        )}
                        {!isFlux && !isSD3 && (
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
                              resources: resourceTypes.filter((x) => x.type === 'VAE'),
                            }}
                          />
                        )}
                      </div>
                    </Accordion.Panel>
                  </Accordion.Item>
                </PersistentAccordion>
              </div>
              <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
                <DailyBoostRewardClaim />
                {subscriptionMismatch && (
                  <DismissibleAlert
                    id="subscription-mismatch-generator-alert"
                    color="red"
                    title="Subscription Mismatch"
                  >
                    <Text size="xs">
                      Looks like we&rsquo;re having trouble correctly applying your membership
                      bonuses, try to <RefreshSessionButton />, if that doesn&rsquo;t work please
                      contact us here <Anchor href="https://civitai.com/support">here</Anchor>
                    </Text>
                  </DismissibleAlert>
                )}
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
                          By using the image generator you confirm that you have read and agree to
                          our{' '}
                          <Text component={Link} href="/content/tos" td="underline">
                            Terms of Service
                          </Text>{' '}
                          presented during onboarding. Failure to abide by{' '}
                          <Text component={Link} href="/content/tos" td="underline">
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
                    {reviewed && (
                      <>
                        <QueueSnackbar />
                        <div className="flex gap-2">
                          <Card withBorder className="flex max-w-24 flex-1 flex-col p-0">
                            <Text className="pr-6 text-center text-xs font-semibold" color="dimmed">
                              Quantity
                            </Text>
                            <InputQuantity
                              name="quantity"
                              className={classes.generateButtonQuantityInput}
                              min={!!isDraft ? 4 : 1}
                              max={
                                !!isDraft
                                  ? Math.floor(status.limits.quantity / 4) * 4
                                  : status.limits.quantity
                              }
                              step={!!isDraft ? 4 : 1}
                            />
                          </Card>

                          <SubmitButton isLoading={isLoading} />
                          <Button onClick={handleReset} variant="default" className="h-auto px-3">
                            Reset
                          </Button>
                        </div>
                      </>
                    )}
                    {status.available && status.message && messageHash && (
                      <DismissibleAlert
                        color="yellow"
                        title="Image Generation Status Alert"
                        id={messageHash}
                      >
                        <CustomMarkdown allowedElements={['a', 'strong']} unwrapDisallowed>
                          {status.message}
                        </CustomMarkdown>
                      </DismissibleAlert>
                    )}
                  </>
                )}
              </div>
            </>
          );
        }}
      </Watch>
    </Form>
  );
}
// #endregion

// #region [ready section]
function ReadySection() {
  const { data } = useTextToImageWhatIfContext();

  return data?.ready === false ? (
    <Card.Section>
      <Alert color="yellow" title="Potentially slow generation" radius={0}>
        <Text size="xs">
          {`We need to download additional resources to fulfill your request. This generation may take longer than usual to complete.`}
        </Text>
      </Alert>
    </Card.Section>
  ) : null;
}
// #endregion

// #region [submit button]
function SubmitButton(props: { isLoading?: boolean }) {
  const { civitaiTip, creatorTip } = useTipStore();
  const { data, isError, isInitialLoading, error } = useTextToImageWhatIfContext();
  const form = useGenerationForm();
  const features = useFeatureFlags();
  const [baseModel, resources] = form.watch(['baseModel', 'resources']);
  const isFlux = getIsFlux(baseModel);
  const isSD3 = getIsSD3(baseModel);
  const hasCreatorTip = (!isFlux && !isSD3) || resources?.length > 0;

  useEffect(() => {
    if (data) {
      useCostStore.setState({ cost: data.cost?.base ?? 0 });
    }
  }, [data?.cost]); // eslint-disable-line

  const cost = data?.cost?.base ?? 0;
  const totalTip =
    Math.ceil(cost * (hasCreatorTip ? creatorTip : 0)) + Math.ceil(cost * civitaiTip);
  const totalCost = features.creatorComp ? cost + totalTip : cost;

  const generateButton = (
    <GenerateButton
      type="submit"
      className="h-full flex-1"
      loading={isInitialLoading || props.isLoading}
      cost={totalCost}
      error={
        !isInitialLoading && isError
          ? error
            ? (error as any).message
            : 'Error calculating cost. Please try updating your values'
          : undefined
      }
    />
  );

  if (!features.creatorComp) return generateButton;

  return (
    <Paper className="flex flex-1" bg="dark.5" radius="sm" p={4} pr={6}>
      <Group className="flex-1" spacing={6} noWrap>
        {generateButton}
        <GenerationCostPopover
          width={300}
          workflowCost={data?.cost ?? {}}
          hideCreatorTip={!hasCreatorTip}
        >
          <ActionIcon variant="subtle" size="xs" color="yellow.7" radius="xl" disabled={!totalCost}>
            <IconInfoCircle stroke={2.5} />
          </ActionIcon>
        </GenerationCostPopover>
      </Group>
    </Paper>
  );
}
// #endregion

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
      borderTopLeftRadius: theme.radius.sm,
      borderTopRightRadius: theme.radius.sm,
    },

    '&:last-of-type': {
      borderBottomLeftRadius: theme.radius.sm,
      borderBottomRightRadius: theme.radius.sm,
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
