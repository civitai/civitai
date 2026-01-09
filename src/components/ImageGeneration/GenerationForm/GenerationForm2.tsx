import type { NumberInputProps, SliderProps } from '@mantine/core';
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Divider,
  Group,
  Input,
  List,
  Notification,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  useMantineTheme,
  useComputedColorScheme,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowAutofitDown,
  IconCheck,
  IconPlus,
  IconRestore,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { clone } from 'lodash-es';
import { useEffect, useMemo, useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useBuyBuzz, useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { InputPrompt } from '~/components/Generate/Input/InputPrompt';
import { GenForm } from '~/components/Generation/Form/GenForm';
import { InputRequestPriorityCompact } from '~/components/Generation/Input/RequestPriority';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { ImageById } from '~/components/Image/ById/ImageById';
import {
  ResourceSelectHandler,
  useGenerationStatus,
  useUnstableResources,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { MembershipUpsell } from '~/components/ImageGeneration/MembershipUpsell';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import type { GenerationFormOutput } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import { useGenerationForm } from '~/components/ImageGeneration/GenerationForm/GenerationFormProvider';
import InputQuantity from '~/components/ImageGeneration/GenerationForm/InputQuantity';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import InputResourceSelect from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import InputResourceSelectMultiple from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import { useTextToImageWhatIfContext } from '~/components/ImageGeneration/GenerationForm/TextToImageWhatIfProvider';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import {
  useInvalidateWhatIf,
  useSubmitCreateImage,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { PersistentAccordion } from '~/components/PersistentAccordion/PersistantAccordion';
import { RefreshSessionButton } from '~/components/RefreshSessionButton/RefreshSessionButton';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import {
  contentGenerationTour,
  remixContentGenerationTour,
} from '~/components/Tours/tours/content-gen.tour';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { InputNumberSlider, InputSegmentedControl, InputSelect, InputSwitch } from '~/libs/form';
import { Watch } from '~/libs/form/components/Watch';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { generation, getGenerationConfig, samplerOffsets } from '~/server/common/constants';
import { imageGenerationSchema } from '~/server/schema/image.schema';
import {
  fluxModelId,
  fluxModeOptions,
  fluxStandardAir,
  fluxUltraAir,
  fluxUltraAspectRatios,
  getIsFlux,
  getIsFluxStandard,
  getIsFluxUltra,
  getIsPonyV7,
  getIsSD3,
  getIsSdxl,
  getIsHiDream,
  getWorkflowDefinitionFeatures,
  sanitizeParamsByWorkflowDefinition,
  fluxDraftAir,
  fluxKreaAir,
  getIsFluxKrea,
  getIsChroma,
  getIsZImageTurbo,
  EXPERIMENTAL_MODE_SUPPORTED_MODELS,
} from '~/shared/constants/generation.constants';
import {
  flux1ModelModeOptions,
  getIsFluxKontext,
} from '~/shared/orchestrator/ImageGen/flux1-kontext.config';
import { getIsImagen4 } from '~/shared/orchestrator/ImageGen/google.config';
import {
  flux2ModelModeOptions,
  getIsFlux2,
  getIsFlux2Dev,
} from '~/shared/orchestrator/ImageGen/flux2.config';
import {
  getModelVersionUsesImageGen,
  imageGenModelVersionMap,
} from '~/shared/orchestrator/ImageGen/imageGen.config';
import {
  getIsQwen,
  qwenModelVersionToModelMap,
  getIsQwenImageEditModel,
  qwenGroupedOptions,
} from '~/shared/orchestrator/ImageGen/qwen.config';
import { ModelType } from '~/shared/utils/prisma/enums';
import { useGenerationStore, useRemixStore } from '~/store/generation.store';
import { useTipStore } from '~/store/tip.store';
import { fetchBlobAsFile } from '~/utils/file-utils';
import { ExifParser, parsePromptMetadata } from '~/utils/metadata';
import { showErrorNotification } from '~/utils/notifications';
import { getRatio, numberWithCommas } from '~/utils/number-helpers';
import { capitalize, getDisplayName, hashify, parseAIR } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import {
  getGenerationBaseModelResourceOptions,
  getGenerationBaseModelsByMediaType,
  getBaseModelGroup,
} from '~/shared/constants/base-model.constants';
import {
  geminiModelVersionMap,
  getIsNanoBanana,
  getIsNanoBananaPro,
  nanoBananaProResolutions,
} from '~/shared/orchestrator/ImageGen/gemini.config';
import {
  InputSourceImageUploadMultiple,
  SourceImageUploadMultiple,
  type ImageAnnotation,
} from '~/components/Generation/Input/SourceImageUploadMultiple';
import {
  getIsSeedream,
  seedreamModelVersionToModelMap,
} from '~/shared/orchestrator/ImageGen/seedream.config';
import { useAppContext } from '~/providers/AppProvider';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { BaseModelSelect } from '~/components/ImageGeneration/GenerationForm/BaseModelSelect';
import { InputPreferredImageFormatCompact } from '~/components/Generation/Input/OutputFormat';
import { openaiModelVersionToModelMap } from '~/shared/orchestrator/ImageGen/openai.config';
import {
  getHiDreamResourceFromPrecisionAndVariant,
  getHiDreamResourceFromVersionId,
  hiDreamPrecisions,
  hiDreamVariants,
  hiDreamVariantsPrecisionMap,
} from '~/shared/orchestrator/hidream.config';
import classes from './GenerationForm2.module.scss';
import { StepProvider } from '~/components/Generation/Providers/StepProvider';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { ResetGenerationPanel } from '~/components/Generation/Error/ResetGenerationPanel';

let total = 0;
const tips = {
  creators: 0,
  civitai: 0,
};

// #region [form component]
export function GenerationFormContent() {
  const { allowMatureContent } = useAppContext();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const featureFlags = useFeatureFlags();
  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : null),
    [status.message]
  );
  const { runTour, running, currentStep, helpers, setSteps, activeTour } = useTourContext();
  const loadingGeneratorData = useGenerationStore((state) => state.loading);
  const remixOfId = useRemixStore((state) => state.remixOfId);
  const [loadingGenQueueRequests, hasGeneratedImages] = useGenerationContext((state) => [
    state.requestsLoading,
    state.hasGeneratedImages,
  ]);

  const form = useGenerationForm();
  const invalidateWhatIf = useInvalidateWhatIf();

  const { unstableResources: allUnstableResources } = useUnstableResources();
  const [promptWarning, setPromptWarning] = useState<string | null>(null);
  const [reviewed, setReviewed] = useLocalStorage({
    key: 'review-generation-terms',
    defaultValue: window?.localStorage?.getItem('review-generation-terms') === 'true',
  });
  const { subscription, meta: subscriptionMeta } = useActiveSubscription();

  const { data: workflowDefinitions = [], isLoading: loadingWorkflows } =
    trpc.generation.getWorkflowDefinitions.useQuery();

  const [workflow] = form.watch(['workflow']) ?? 'txt2img';
  const baseModel = form.watch('baseModel');
  const model = form.watch('model');
  const fluxMode = form.watch('fluxMode');
  const [sourceImage] = form.watch(['sourceImage']);
  const [images, imageAnnotations] = form.watch(['images', 'imageAnnotations']);
  const workflowDefinition = workflowDefinitions?.find((x) => x.key === workflow);

  const runsOnFalAI =
    model?.model?.id === fluxModelId && fluxMode !== fluxStandardAir && fluxMode !== fluxKreaAir;

  const features = getWorkflowDefinitionFeatures(workflowDefinition);
  features.draft = features.draft && featureFlags.draftMode;

  const { errors } = form.formState;

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.generation,
    setFilters: state.setGenerationFilters,
  }));

  function clearWarning() {
    setPromptWarning(null);
  }

  function handleReset() {
    form.reset();
    useRemixStore.setState({
      remixOf: undefined,
      params: undefined,
      resources: undefined,
      remixOfId: undefined,
    });
    clearWarning();
  }

  // #region [handle parse prompt]
  const [showFillForm, setShowFillForm] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  async function handleParsePrompt() {
    const prompt = form.getValues('prompt');
    const metadata = parsePromptMetadata(prompt ?? '');
    const result = imageGenerationSchema.safeParse(metadata);
    if (result.success) {
      const { resources, ...data } = result.data;
      form.setValues(data);
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

  // const availableBuzz = useAvailableBuzz();
  const { conditionalPerformTransaction } = useBuzzTransaction({
    accountTypes: buzzSpendTypes,
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const { mutateAsync, isLoading } = useSubmitCreateImage();
  const buyBuzz = useBuyBuzz();

  function handleSubmit(data: GenerationFormOutput) {
    if (isLoading) return;
    // const { cost = 0 } = useCostStore.getState();

    const {
      model,
      resources: formResources,
      vae,
      remixOfId,
      remixSimilarity,
      upscaleHeight,
      upscaleWidth,
      imageAnnotations,
      ...params
    } = data;
    let additionalResources = formResources ?? [];
    sanitizeParamsByWorkflowDefinition(params, workflowDefinition);
    const modelClone = clone(model);

    if (disablePriority) params.priority = 'low';

    const isFlux = getIsFlux(params.baseModel);
    const isFluxStandard = getIsFluxStandard(model.model.id);
    const isFlux2NotDev = getIsFlux2(model.id) && !getIsFlux2Dev(model.id);
    if (isFlux && isFluxStandard) {
      if (params.fluxMode) {
        const { version } = parseAIR(params.fluxMode);
        modelClone.id = version;
      }
    } else {
      delete params.fluxMode;
      delete params.fluxUltraAspectRatio;
    }

    if (isFlux2NotDev) additionalResources = []; // No additional resources allowed

    delete params.engine;
    if (isFluxStandard && params.fluxUltraRaw && params.fluxMode === fluxUltraAir)
      params.engine = 'flux-pro-raw';

    const imageGenEngine = imageGenModelVersionMap.get(model.id);
    if (imageGenEngine) params.engine = imageGenEngine;

    if (workflowDefinition?.type === 'txt2img') params.sourceImage = null;

    const resources = [modelClone, ...additionalResources, vae]
      .filter(isDefined)
      .filter((x) => x.canGenerate !== false)
      .map((r) => ({
        ...r,
        epochNumber: r.epochDetails?.epochNumber,
      }));

    async function performTransaction() {
      if (!params.baseModel) throw new Error('could not find base model');

      const hasEarlyAccess = resources.some((x) => x.earlyAccessEndsAt);
      setSubmitError(undefined);
      await mutateAsync({
        resources,
        params: {
          ...params,
          // nsfw: hasMinorResources || !featureFlags.canViewNsfw ? false : params.nsfw,
          disablePoi: browsingSettingsAddons.settings.disablePoi,
          experimental: data.enhancedCompatibility,
        },
        tips,
        remixOfId: remixSimilarity && remixSimilarity > 0.75 ? remixOfId : undefined,
      }).catch((error: any) => {
        if (
          allowMatureContent &&
          (error.message?.startsWith('Your prompt was flagged') || error.message?.includes('POI'))
        ) {
          setPromptWarning(error.message);
          currentUser?.refresh();
        }
        if (error?.message === 'insufficientBuzz') {
          buyBuzz({});
        } else
          setSubmitError(error.message ?? 'An unexpected error occurred. Please try again later.');
      });

      if (hasEarlyAccess) {
        invalidateWhatIf();
      }
    }

    setPromptWarning(null);
    conditionalPerformTransaction(total, performTransaction);

    if (filters.marker) {
      setFilters({ marker: undefined });
    }
  }

  const [hasMinorResources, setHasMinorResources] = useState(false);

  useEffect(() => {
    const subscription = form.watch(({ model, resources, vae }, { name }) => {
      if (name === 'model' || name === 'resources' || name === 'vae') {
        setHasMinorResources(
          [model, ...(resources ?? []), vae].filter((x) => x?.model?.sfwOnly || x?.model?.minor)
            .length > 0
        );
      }
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const workflowOptions = workflowDefinitions
    .filter((x) => x.selectable !== false)
    .map(({ key, label }) => ({ label, value: key }));

  useEffect(() => {
    if (!status.available || status.isLoading || loadingGeneratorData) return;
    if (!running) runTour({ key: remixOfId ? 'remix-content-generation' : 'content-generation' });
  }, [
    status.isLoading,
    status.available,
    loadingGenQueueRequests,
    hasGeneratedImages,
    remixOfId,
    loadingGeneratorData,
  ]); // These are the dependencies that make it work, please only update if you know what you're doing

  useEffect(() => {
    if (!running || currentStep > 0 || loadingGeneratorData) return;
    const isRemix = remixOfId && activeTour === 'remix-content-generation';
    let genSteps = isRemix ? remixContentGenerationTour : contentGenerationTour;

    // Remove last two steps if user has not generated any images
    if (!loadingGenQueueRequests && !hasGeneratedImages) genSteps = genSteps.slice(0, -2);
    // Only show first few steps if user is not logged in
    if (!currentUser) genSteps = isRemix ? genSteps.slice(0, 4) : genSteps.slice(0, 6);

    const alreadyReviewedTerms =
      window?.localStorage?.getItem('review-generation-terms') === 'true';
    if (alreadyReviewedTerms)
      genSteps = genSteps.filter((x) => x.target !== '[data-tour="gen:terms"]');

    setSteps(genSteps);
  }, [
    loadingGenQueueRequests,
    hasGeneratedImages,
    remixOfId,
    currentUser,
    running,
    activeTour,
    loadingGeneratorData,
  ]); // These are the dependencies that make it work, please only update if you know what you're doing

  const [minDenoise, setMinDenoise] = useState(0);
  useEffect(() => {
    if (sourceImage)
      fetchBlobAsFile(sourceImage.url).then(async (file) => {
        if (file) {
          const parser = await ExifParser(file);
          const data = parser.parse();
          const min = data ? 0 : 0.5;
          const denoise = form.getValues('denoise') ?? 0.4;
          if (min > denoise) form.setValue('denoise', 0.65);
          setMinDenoise(min);
        }
      });
    else setMinDenoise(0);
  }, [sourceImage, form]);

  const isSDXL = getIsSdxl(baseModel);
  const isFlux = getIsFlux(baseModel);
  const isSD3 = getIsSD3(baseModel);
  const isQwen = getIsQwen(model.id);
  const isChroma = getIsChroma(baseModel);
  const isZImageTurbo = getIsZImageTurbo(baseModel);
  const isPonyV7 = getIsPonyV7(model.id);

  // HiDream
  const isHiDream = getIsHiDream(baseModel);
  const hiDreamResource = getHiDreamResourceFromVersionId(model.id);

  // ImageGen constants
  const isImageGen = getModelVersionUsesImageGen(model.id);
  const isOpenAI = baseModel === 'OpenAI';
  const isImagen4 = getIsImagen4(model.id);
  const isFluxKontext = getIsFluxKontext(model.id);
  const isFlux2 = getIsFlux2(model.id);
  const isNanoBanana = getIsNanoBanana(model.id);
  const isSeedream = getIsSeedream(model.id);
  const isQwenImageEdit = getIsQwenImageEditModel(model.id);
  const showImg2ImgMultiple = isNanoBanana || isSeedream || isFlux2 || isOpenAI || isQwenImageEdit;
  const isNanoBananaPro = getIsNanoBananaPro(model.id);

  const disablePriority = runsOnFalAI || isOpenAI || isNanoBanana || isSeedream;

  // Model mode configuration - add new models here
  const modelModeConfig = useMemo(
    () => [
      { isActive: isFluxKontext, options: flux1ModelModeOptions },
      { isActive: isFlux2, options: flux2ModelModeOptions },
      // { isActive: getIsQwenImageGen(model.id), options: qwenModelModeOptions },
      // Add future model modes here
    ],
    [isFluxKontext, isFlux2]
  );

  const activeModelMode = modelModeConfig.find((config) => config.isActive);

  const stepProviderValue = useMemo(() => ({ baseModel }), [baseModel]);

  return (
    <StepProvider value={stepProviderValue}>
      <GenForm
        form={form}
        onSubmit={handleSubmit}
        className="relative flex flex-1 flex-col justify-between gap-2"
      >
        <Watch {...form} fields={['fluxMode', 'draft', 'workflow', 'sourceImage', 'images']}>
          {({ fluxMode, draft, workflow, sourceImage, images }) => {
            // const isTxt2Img = workflow.startsWith('txt') || (isOpenAI && !sourceImage);
            const isImg2Img =
              workflow?.startsWith('img') ||
              (isImageGen && (sourceImage || !!images?.length)) ||
              isFluxKontext;
            const isFluxStandard = getIsFluxStandard(model.model.id);
            const isDraft = isFluxStandard
              ? fluxMode === fluxDraftAir
              : isSD3
              ? model.id === 983611
              : features.draft &&
                !!draft &&
                !isImageGen &&
                !isFlux &&
                !isQwen &&
                !isChroma &&
                !isZImageTurbo &&
                !isFlux2 &&
                !isPonyV7;
            const minQuantity = !!isDraft ? 4 : 1;
            const maxQuantity = isOpenAI
              ? 10
              : !!isDraft
              ? Math.floor(status.limits.quantity / 4) * 4
              : status.limits.quantity;
            const cfgDisabled = isDraft;
            const samplerDisabled = isDraft;
            const stepsDisabled = isDraft;
            let stepsMin = isDraft ? 3 : 10;
            let stepsMax = isDraft ? 12 : status.limits.steps;
            if (isFlux || isSD3 || isQwen || isChroma || isFlux2 || isPonyV7) {
              stepsMin = isDraft ? 4 : 20;
              stepsMax = isDraft ? 4 : 50;
            }

            if (isZImageTurbo) {
              stepsMin = 1;
              stepsMax = 15;
            }

            let cfgScaleMin = 1;
            let cfgScaleMax = isSDXL ? 10 : 30;
            let cfgScaleStep = 0.5;
            if (isFlux || isSD3 || isFluxKontext || isQwen || isChroma || isFlux2 || isPonyV7) {
              cfgScaleMin = isDraft ? 1 : 2;
              cfgScaleMax = isDraft ? 1 : 20;
            }

            if (isZImageTurbo) {
              cfgScaleMin = 1;
              cfgScaleMax = 2;
              cfgScaleStep = 0.1;
            }

            const isFluxUltra = getIsFluxUltra({ modelId: model?.model.id, fluxMode });
            const isFluxKrea = getIsFluxKrea({ modelId: model?.model.id, fluxMode });
            const isFlux2NotDev = isFlux2 && !getIsFlux2Dev(model.id);

            const disableAdditionalResources =
              runsOnFalAI ||
              isOpenAI ||
              isImagen4 ||
              isFluxKontext ||
              isNanoBanana ||
              isSeedream ||
              isFlux2NotDev;
            const disableAdvanced =
              isFluxUltra || isOpenAI || isImagen4 || isHiDream || isNanoBanana;
            const disableNegativePrompt =
              isFlux ||
              isFlux2 ||
              isOpenAI ||
              isFluxKontext ||
              (isHiDream && hiDreamResource?.variant !== 'full') ||
              (isNanoBanana && !isNanoBananaPro) ||
              isSeedream ||
              isZImageTurbo;
            const disableWorkflowSelect =
              isFlux ||
              isSD3 ||
              isImageGen ||
              isHiDream ||
              isFluxKontext ||
              isQwen ||
              isNanoBanana ||
              isChroma ||
              isZImageTurbo ||
              isFlux2 ||
              isSeedream ||
              isPonyV7;
            const disableDraft =
              !features.draft ||
              isOpenAI ||
              isFlux ||
              isQwen ||
              isSD3 ||
              isImagen4 ||
              isHiDream ||
              isFluxKontext ||
              isNanoBanana ||
              isChroma ||
              isZImageTurbo ||
              isFlux2 ||
              isSeedream ||
              isPonyV7;
            const enableImageInput =
              (features.image &&
                !isFlux &&
                !isSD3 &&
                !isQwen &&
                !isChroma &&
                !isZImageTurbo &&
                !isOpenAI &&
                !isPonyV7 &&
                !isNanoBanana &&
                !isSeedream &&
                !isQwenImageEdit) ||
              isFluxKontext;
            const disableCfgScale = isFluxUltra;
            const disableSampler =
              isFlux ||
              isQwen ||
              isSD3 ||
              isFluxKontext ||
              isChroma ||
              isZImageTurbo ||
              isFlux2 ||
              isPonyV7 ||
              isSeedream;
            const disableSteps = isFluxUltra || isFluxKontext || isSeedream;
            const disableClipSkip =
              isSDXL ||
              isFlux ||
              isQwen ||
              isSD3 ||
              isFluxKontext ||
              isChroma ||
              isZImageTurbo ||
              isFlux2 ||
              isPonyV7 ||
              isSeedream;
            const disableVae =
              isFlux ||
              isFlux2 ||
              isQwen ||
              isSD3 ||
              isFluxKontext ||
              isPonyV7 ||
              isSeedream ||
              isZImageTurbo;
            const disableDenoise = !features.denoise || isFluxKontext;
            const disableSafetyTolerance = !isFluxKontext;
            const disableAspectRatio =
              (isFluxUltra || isImg2Img || showImg2ImgMultiple) &&
              !isSeedream &&
              !isNanoBananaPro &&
              !isFlux2 &&
              !isQwen &&
              !isOpenAI;

            const resourceTypes = getGenerationBaseModelResourceOptions(baseModel);
            if (!resourceTypes)
              return (
                <ResetGenerationPanel
                  onResetClick={() => {
                    form.reset();
                  }}
                />
              );

            return (
              <>
                <div className="flex flex-col gap-2 px-3">
                  {!disableWorkflowSelect && (
                    <div className="flex items-start justify-start gap-3">
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
                          className="flex-1"
                          name="workflow"
                          data={[
                            ...workflowOptions.filter((x) => x.value.startsWith('txt')),
                            ...workflowOptions.filter((x) => x.value.startsWith('img')),
                          ]}
                          loading={loadingWorkflows}
                        />
                        {workflowDefinition?.description && (
                          <Text size="xs" lh={1.2} c="dimmed" className="my-2">
                            {workflowDefinition.description}
                          </Text>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="-mb-1 flex items-end justify-between gap-1">
                    <div className="flex items-center gap-1">
                      <Input.Label style={{ fontWeight: 590 }} required>
                        Model
                      </Input.Label>
                      <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                        <Text fw={400}>
                          Models are the resources you&apos;re generating with. Using a different
                          base model can drastically alter the style and composition of images,
                          while adding additional resource can change the characters, concepts and
                          objects
                        </Text>
                      </InfoPopover>
                    </div>
                    <BaseModelSelect
                      value={model ? getBaseModelGroup(model.baseModel) : undefined}
                      type="image"
                    />
                  </div>

                  <Watch {...form} fields={['model', 'resources', 'vae', 'fluxMode']}>
                    {({ model, resources: formResources, vae }) => {
                      const resources = formResources ?? [];
                      const selectedResources = [...resources, vae, model].filter(isDefined);
                      const minorFlaggedResources = selectedResources.filter((x) => x.model.minor);
                      const sfwFlaggedResources = selectedResources.filter((x) => x.model.sfwOnly);
                      const unstableResources = selectedResources.filter((x) =>
                        allUnstableResources.includes(x.id)
                      );
                      const atLimit = resources.length >= status.limits.resources;

                      const resourceSelectHandlerOptions = {
                        canGenerate: true,
                        resources: resourceTypes.filter(
                          (x) => x.type !== 'VAE' && x.type !== 'Checkpoint'
                        ),
                        excludeIds: selectedResources.map((r) => r.id),
                      };

                      const additionResourceTitle = 'Add additional resource';
                      const resourceSelectHandler = ResourceSelectHandler(
                        resourceSelectHandlerOptions
                      );

                      return (
                        <Card
                          className={clsx(
                            { [classes.formError]: form.formState.errors.resources },
                            'flex overflow-visible'
                          )}
                          p={0}
                          radius="sm"
                          withBorder
                        >
                          <InputResourceSelect
                            name="model"
                            buttonLabel="Add Model"
                            allowRemove={false}
                            className="p-3"
                            options={{
                              canGenerate: true,
                              resources: resourceTypes
                                .filter((x) => x.type === 'Checkpoint')
                                .map(({ type, baseModels }) => ({
                                  type,
                                  baseModels:
                                    !!resources?.length || !!vae
                                      ? baseModels
                                      : getGenerationBaseModelsByMediaType('image'),
                                })), // TODO - needs to be able to work when no resources selected (baseModels should be empty array)
                            }}
                            hideVersion={isFluxStandard || isFlux2 || isHiDream || isImageGen}
                            isPreview={isZImageTurbo || isFlux2}
                            pb={
                              unstableResources.length ||
                              minorFlaggedResources.length ||
                              sfwFlaggedResources.length
                                ? 'sm'
                                : undefined
                            }
                          />
                          {!disableAdditionalResources &&
                            resourceSelectHandlerOptions.resources.length > 0 && (
                              <Card.Section
                                className={clsx({
                                  [classes.formError]: form.formState.errors.resources,
                                })}
                                m={0}
                                withBorder
                              >
                                <PersistentAccordion
                                  storeKey="generation-form-resources"
                                  classNames={{
                                    item: classes.accordionItem,
                                    control: classes.accordionControl,
                                    content: classes.accordionContent,
                                    label: classes.accordionLabel,
                                  }}
                                  transitionDuration={0}
                                >
                                  <Accordion.Item value="resources" className="border-b-0">
                                    <Accordion.Control
                                      className={clsx({
                                        [classes.formError]: form.formState.errors.resources,
                                      })}
                                    >
                                      <div className="flex flex-col gap-1">
                                        <div className="flex items-center gap-1">
                                          <Text size="sm" fw={590}>
                                            Additional Resources
                                          </Text>
                                          {resources.length > 0 && (
                                            <Badge className="font-semibold">
                                              {resources.length}/{status.limits.resources}
                                            </Badge>
                                          )}

                                          <Button
                                            component="span"
                                            size="compact-sm"
                                            variant="light"
                                            onClick={(e: React.MouseEvent) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              const formResources =
                                                form.getValues('resources') ?? [];
                                              resourceSelectHandler
                                                .select({
                                                  title: additionResourceTitle,
                                                  excludedIds: formResources.map((x) => x.id),
                                                })
                                                .then((resource) => {
                                                  if (!resource) return;
                                                  const resources = [
                                                    ...formResources,
                                                    resource,
                                                  ] as GenerationResource[];
                                                  const newValue =
                                                    resourceSelectHandler.getValues(resources) ??
                                                    [];
                                                  form.setValue('resources', newValue);
                                                });
                                            }}
                                            radius="xl"
                                            ml="auto"
                                            disabled={atLimit}
                                            classNames={{ inner: 'flex gap-1' }}
                                          >
                                            <IconPlus size={16} />
                                            <Text size="sm" fw={500}>
                                              Add
                                            </Text>
                                          </Button>
                                        </div>

                                        {atLimit &&
                                          (!currentUser || currentUser.tier === 'free') && (
                                            <Text size="xs">
                                              <Link legacyBehavior href="/pricing" passHref>
                                                <Anchor
                                                  color="yellow"
                                                  rel="nofollow"
                                                  onClick={(e: React.MouseEvent) =>
                                                    e.stopPropagation()
                                                  }
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
                                    <Accordion.Panel classNames={{ content: 'p-0' }}>
                                      <InputResourceSelectMultiple
                                        name="resources"
                                        limit={status.limits.resources}
                                        buttonLabel={additionResourceTitle}
                                        options={resourceSelectHandlerOptions}
                                        hideButton
                                      />
                                    </Accordion.Panel>
                                  </Accordion.Item>
                                </PersistentAccordion>
                              </Card.Section>
                            )}

                          {unstableResources.length > 0 && (
                            <Card.Section m={0}>
                              <Alert color="yellow" title="Unstable Resources" radius={0}>
                                <Text size="xs">
                                  The following resources are experiencing a high generation failure
                                  rate, possibly due to temporary generator instability. This
                                  usually resolves with time and does not require action from you.
                                  This notice will be removed once performance stabilizes.
                                </Text>
                                <List size="xs">
                                  {unstableResources.map((resource) => (
                                    <List.Item key={resource.id}>
                                      {resource.model.name} - {resource.name}
                                    </List.Item>
                                  ))}
                                </List>
                              </Alert>
                            </Card.Section>
                          )}
                          {(!!minorFlaggedResources.length || !!sfwFlaggedResources.length) && (
                            <Card.Section m={0}>
                              <Alert color="yellow" title="Content Restricted" radius={0}>
                                <Text size="xs">
                                  {!!minorFlaggedResources.length
                                    ? `A resource you selected does not allow the generation of non-PG level content. If you attempt to generate non-PG`
                                    : `A resource you selected does not allow the generation of content rated above PG level. If you attempt to generate sexualized `}
                                  content with this resource the image will not be returned, but you{' '}
                                  <Text span italic inherit>
                                    will
                                  </Text>
                                  {` be charged Buzz.`}
                                </Text>{' '}
                                <List size="xs">
                                  {minorFlaggedResources.map((resource) => (
                                    <List.Item key={resource.id}>
                                      {resource.model.name} - {resource.name}
                                    </List.Item>
                                  ))}
                                </List>
                              </Alert>
                            </Card.Section>
                          )}
                          {!isFlux &&
                            !isQwen &&
                            !isSD3 &&
                            !isChroma &&
                            !isZImageTurbo &&
                            !isFlux2 &&
                            !isPonyV7 && <ReadySection />}
                        </Card>
                      );
                    }}
                  </Watch>

                  {isOpenAI && (
                    <SegmentedControl
                      value={model.id ? String(model.id) : undefined}
                      data={[...openaiModelVersionToModelMap.entries()].map(([key, { name }]) => ({
                        value: String(key),
                        label: name,
                      }))}
                      onChange={(stringModelId) => {
                        form.setValue('model', { ...model, id: Number(stringModelId) });
                      }}
                    />
                  )}

                  {isNanoBanana && (
                    <SegmentedControl
                      value={model.id ? String(model.id) : undefined}
                      data={[...geminiModelVersionMap.entries()].map(([key, { name }]) => ({
                        value: String(key),
                        label: name,
                      }))}
                      onChange={(stringModelId) => {
                        form.setValue('model', { ...model, id: Number(stringModelId) });
                      }}
                    />
                  )}

                  {isSeedream && (
                    <SegmentedControl
                      value={model.id ? String(model.id) : undefined}
                      data={[...seedreamModelVersionToModelMap.entries()].map(
                        ([key, { name }]) => ({
                          value: String(key),
                          label: name,
                        })
                      )}
                      onChange={(stringModelId) => {
                        form.setValue('model', { ...model, id: Number(stringModelId) });
                      }}
                    />
                  )}

                  {isQwen && (
                    <Select
                      label="Mode"
                      value={model.id ? String(model.id) : null}
                      data={qwenGroupedOptions}
                      onChange={(stringModelId) => {
                        if (!stringModelId) return;
                        const modelVersionId = Number(stringModelId);
                        const selectedOption = qwenModelVersionToModelMap.get(modelVersionId);
                        form.setValue('model', {
                          ...model,
                          id: modelVersionId,
                          model: selectedOption
                            ? { ...model.model, id: selectedOption.modelId }
                            : model.model,
                        });
                      }}
                    />
                  )}

                  {enableImageInput && (
                    <InputSourceImageUpload
                      name="sourceImage"
                      label={isOpenAI ? 'Image (optional)' : undefined}
                      warnOnMissingAiMetadata={isFluxKontext}
                    />
                  )}

                  {showImg2ImgMultiple && (
                    <div className="-mx-2">
                      <InputSourceImageUploadMultiple
                        name="images"
                        aspect="video"
                        max={7}
                        warnOnMissingAiMetadata
                        enableDrawing
                        annotations={imageAnnotations}
                        onDrawingComplete={(compositeImage, index, lines) => {
                          const currentImages = form.getValues('images') ?? [];
                          const currentAnnotations = form.getValues('imageAnnotations') ?? [];

                          const currentImage = currentImages[index];
                          if (!currentImage) return;

                          // Check if this image is already annotated (re-editing)
                          const existingAnnotation = currentAnnotations.find(
                            (a: ImageAnnotation) => a.compositeUrl === currentImage.url
                          );

                          // The original is either from existing annotation or the current image
                          const originalImage = existingAnnotation
                            ? {
                                url: existingAnnotation.originalUrl,
                                width: existingAnnotation.originalWidth,
                                height: existingAnnotation.originalHeight,
                              }
                            : currentImage;

                          // 1. Replace image in array with composite
                          const updatedImages = [...currentImages];
                          updatedImages[index] = compositeImage;
                          form.setValue('images', updatedImages);

                          // 2. Update annotations - remove old if re-editing, add new
                          const filteredAnnotations = currentAnnotations.filter(
                            (a: ImageAnnotation) =>
                              a.compositeUrl !== currentImage.url &&
                              a.originalUrl !== originalImage.url
                          );
                          form.setValue('imageAnnotations', [
                            ...filteredAnnotations,
                            {
                              originalUrl: originalImage.url,
                              originalWidth: originalImage.width,
                              originalHeight: originalImage.height,
                              compositeUrl: compositeImage.url,
                              lines,
                            },
                          ]);
                        }}
                        onRemove={(removedImage) => {
                          // Remove annotation if this was a composite
                          const currentAnnotations = form.getValues('imageAnnotations') ?? [];
                          const filtered = currentAnnotations.filter(
                            (a: ImageAnnotation) => a.compositeUrl !== removedImage.url
                          );
                          form.setValue('imageAnnotations', filtered);
                        }}
                      >
                        {(previewItems) => (
                          <div className="grid grid-cols-2 gap-4 @xs:grid-cols-3 @sm:grid-cols-4">
                            {previewItems.map((item, i) => (
                              <SourceImageUploadMultiple.Image key={item.url} index={i} {...item} />
                            ))}
                            <SourceImageUploadMultiple.Dropzone />
                          </div>
                        )}
                      </InputSourceImageUploadMultiple>
                    </div>
                  )}

                  {(isSD3 || isQwen) && (
                    <Alert className="overflow-visible">
                      This is an experimental build, as such pricing and results are subject to
                      change
                    </Alert>
                  )}

                  {activeModelMode && (
                    <div className="flex flex-col gap-0.5">
                      <Input.Label>Model Mode</Input.Label>
                      <SegmentedControl
                        value={String(model.id)}
                        data={activeModelMode.options}
                        onChange={(value) => {
                          const modelVersionId = Number(value);
                          if (model.id !== modelVersionId)
                            form.setValue('model', { ...model, id: modelVersionId });
                        }}
                      />
                    </div>
                  )}

                  {isHiDream && hiDreamResource && (
                    <>
                      <div className="flex flex-col gap-0.5">
                        <Input.Label>Precision</Input.Label>
                        <SegmentedControl
                          value={hiDreamResource.precision}
                          data={[...hiDreamPrecisions]}
                          onChange={(precision) => {
                            const versionId = getHiDreamResourceFromPrecisionAndVariant({
                              ...hiDreamResource,
                              precision,
                            })?.id;
                            if (versionId && model.id !== versionId)
                              form.setValue('model', { ...model, id: versionId });
                          }}
                        />
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <Input.Label>Variant</Input.Label>
                        <SegmentedControl
                          value={hiDreamResource.variant}
                          data={hiDreamVariantsPrecisionMap[hiDreamResource.precision].map(
                            (value) => ({
                              label: capitalize(value),
                              value,
                            })
                          )}
                          onChange={(variant) => {
                            const versionId = getHiDreamResourceFromPrecisionAndVariant({
                              ...hiDreamResource,
                              variant,
                            })?.id;
                            if (versionId && model.id !== versionId)
                              form.setValue('model', { ...model, id: versionId });
                          }}
                        />
                      </div>
                    </>
                  )}

                  {isFluxStandard && (
                    <Watch {...form} fields={['resources']}>
                      {({ resources }) => {
                        return (
                          <div className="flex flex-col gap-0.5">
                            <Input.Label className="flex items-center gap-1">
                              Model Mode
                            </Input.Label>
                            <InputSegmentedControl
                              name="fluxMode"
                              data={fluxModeOptions}
                              disabled={!!resources?.length}
                            />
                          </div>
                        );
                      }}
                    </Watch>
                  )}

                  {isFluxKrea && (
                    <Alert>Note: FLUX Krea is experimental. Pricing is subject to change.</Alert>
                  )}

                  <div className="flex flex-col">
                    <Watch
                      {...form}
                      fields={[
                        'remixSimilarity',
                        'remixOfId',
                        'remixPrompt',
                        'remixNegativePrompt',
                      ]}
                    >
                      {({ remixSimilarity, remixOfId, remixPrompt, remixNegativePrompt }) => {
                        if (!remixOfId || !remixPrompt || !remixSimilarity) return <></>;

                        return (
                          <div className="my-2 flex flex-col gap-2 overflow-hidden rounded-md">
                            <div
                              className={clsx('flex rounded-md', {
                                'border-2 border-red-500': remixSimilarity < 0.75,
                              })}
                            >
                              <div className=" flex-none">
                                <ImageById
                                  imageId={remixOfId}
                                  className="h-28 rounded-none rounded-l-md"
                                  explain={false}
                                />
                              </div>
                              <div className="h-28 flex-1">
                                <Alert
                                  style={{
                                    background:
                                      colorScheme === 'dark' ? theme.colors.dark[6] : undefined,
                                    borderTopLeftRadius: 0,
                                    borderBottomLeftRadius: 0,
                                  }}
                                  h="100%"
                                  py={0}
                                >
                                  <Stack gap={0} h="100%">
                                    <Text fw="bold" size="sm" mt={2}>
                                      Remixing
                                    </Text>
                                    {remixSimilarity >= 0.75 && (
                                      <Text size="xs" lineClamp={3}>
                                        {remixPrompt}
                                      </Text>
                                    )}
                                    {
                                      remixSimilarity < 0.75 ? (
                                        <>
                                          <Text size="xs" lh={1.2} mb={6}>
                                            Your prompt has deviated sufficiently from the original
                                            that this generation will be treated as a new image
                                            rather than a remix
                                          </Text>
                                          <Group gap="xs" grow wrap="nowrap">
                                            <Button
                                              variant="default"
                                              onClick={() => {
                                                form.setValue(
                                                  'prompt',
                                                  remixPrompt.replace(
                                                    /\(*([^():,]+)(?::[0-9.]+)?\)*/g,
                                                    `$1`
                                                  )
                                                );
                                                form.setValue(
                                                  'negativePrompt',
                                                  remixNegativePrompt?.replace(
                                                    /\(*([^():,]+)(?::[0-9.]+)?\)*/g,
                                                    `$1`
                                                  )
                                                );
                                              }}
                                              size="xs"
                                              color="default"
                                              fullWidth
                                              h={30}
                                              leftSection={<IconRestore size={14} />}
                                            >
                                              Restore Prompt
                                            </Button>
                                            <Button
                                              variant="light"
                                              color="red"
                                              size="xs"
                                              onClick={() => {
                                                form.setValues({
                                                  remixOfId: undefined,
                                                  remixSimilarity: undefined,
                                                  remixPrompt: undefined,
                                                  remixNegativePrompt: undefined,
                                                });
                                              }}
                                              fullWidth
                                              h={30}
                                              leftSection={<IconX size={14} />}
                                            >
                                              Stop Remixing
                                            </Button>
                                          </Group>
                                        </>
                                      ) : null
                                      // : (
                                      //   <Text
                                      //     variant="link"
                                      //     className="cursor-pointer"
                                      //     size="xs"
                                      //     lh={1.2}
                                      //     mb={6}
                                      //     onClick={() => {
                                      //       form.setValue('prompt', remixPrompt);
                                      //       form.setValue('negativePrompt', remixNegativePrompt);
                                      //     }}
                                      //   >
                                      //     Restore original prompt weights
                                      //   </Text>
                                      // )
                                    }
                                  </Stack>
                                </Alert>
                              </div>
                            </div>
                          </div>
                        );
                      }}
                    </Watch>
                    <Input.Wrapper
                      label={
                        <div className="mb-1 flex items-center gap-1">
                          <Input.Label required={!isImg2Img}>Prompt</Input.Label>
                          <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                            Type out what you&apos;d like to generate in the prompt, add aspects
                            you&apos;d like to avoid in the negative prompt
                          </InfoPopover>
                        </div>
                      }
                      error={errors.prompt?.message}
                    >
                      <Watch {...form} fields={['resources']}>
                        {({ resources }) => {
                          const trainedWords =
                            resources?.flatMap((x) => x.trainedWords).filter(isDefined) ?? [];

                          return (
                            <Paper
                              className={clsx(
                                classes.promptPaper,
                                {
                                  [classes.noFillForm]: !showFillForm,
                                  [classes.fillForm]: showFillForm,
                                  [classes.hasError]: errors.prompt,
                                },
                                'mantine-focus-auto'
                              )}
                              withBorder
                            >
                              <InputPrompt
                                name="prompt"
                                data-tour="gen:prompt"
                                placeholder="Your prompt goes here..."
                                minRows={2}
                                autosize
                                styles={(theme) => ({
                                  input: {
                                    width: '100%',
                                    resize: 'none',
                                    border: 'none',
                                    outline: 'none',
                                    fontFamily: theme.fontFamily,
                                    fontSize: theme.fontSizes.sm,
                                    lineHeight: theme.lineHeights.sm,
                                    overflow: 'hidden',
                                    backgroundColor: 'transparent',
                                    padding: '10px 0',
                                  },
                                  // Prevents input from displaying form error
                                  error: { display: 'none' },
                                  wrapper: { margin: 0 },
                                })}
                                onPaste={(event) => {
                                  const text = event.clipboardData.getData('text/plain');
                                  if (text) setShowFillForm(text.includes('Steps:'));
                                }}
                              />
                              {trainedWords.length > 0 ? (
                                <div className="mb-1 flex flex-col gap-2">
                                  <Divider />
                                  <Text c="dimmed" className="text-xs font-semibold">
                                    Trigger words
                                  </Text>
                                  <div className="mb-2 flex items-center gap-1">
                                    <TrainedWords
                                      type="LORA"
                                      trainedWords={trainedWords}
                                      badgeProps={{
                                        style: {
                                          textTransform: 'none',
                                          height: 'auto',
                                          cursor: 'pointer',
                                        },
                                      }}
                                    />
                                    <CopyButton value={trainedWords.join(', ')}>
                                      {({ copied, copy, Icon, color }) => (
                                        <Button
                                          variant="subtle"
                                          color={color ?? 'blue.5'}
                                          onClick={copy}
                                          size="compact-xs"
                                          classNames={{ root: 'shrink-0', inner: 'flex gap-1' }}
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
                        leftSection={<IconArrowAutofitDown size={16} />}
                        style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}
                        fullWidth
                      >
                        Apply Parameters
                      </Button>
                    )}
                  </div>

                  {!disableNegativePrompt && (
                    <InputPrompt name="negativePrompt" label="Negative Prompt" autosize />
                  )}
                  {isFluxUltra && (
                    <InputSwitch
                      name="fluxUltraRaw"
                      labelPosition="left"
                      label={
                        <div className="relative flex items-center gap-1">
                          <Input.Label>Raw mode</Input.Label>
                          <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                            Generates images with a more natural, less synthetic aesthetic,
                            enhancing diversity in human subjects and improving the realism of
                            nature photography.
                          </InfoPopover>
                        </div>
                      }
                    />
                  )}

                  {isNanoBananaPro && (
                    <div className="flex flex-col gap-0.5">
                      <Input.Label>Resolution</Input.Label>
                      <InputSegmentedControl name="resolution" data={nanoBananaProResolutions} />
                    </div>
                  )}

                  {!disableAspectRatio && (
                    <div className="flex flex-col gap-0.5">
                      <Input.Label>Aspect Ratio</Input.Label>
                      <InputSegmentedControl
                        name="aspectRatio"
                        data={getAspectRatioControls(
                          getGenerationConfig(baseModel, model.id).aspectRatios
                        )}
                      />
                    </div>
                  )}

                  {isFluxUltra && (
                    <InputSelect
                      name="fluxUltraAspectRatio"
                      label="Aspect Ratio"
                      data={fluxUltraAspectRatios.map((ratio, i) => ({
                        label: ratio.label,
                        value: `${i}`,
                      }))}
                      withScrollArea
                      maxDropdownHeight={300}
                    />
                  )}

                  {!disableDraft && (
                    <InputSwitch
                      className="my-2"
                      name="draft"
                      labelPosition="left"
                      label={
                        <div className="relative flex items-center gap-1">
                          <Input.Label>Draft Mode</Input.Label>
                          <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                            Draft Mode will generate images faster, cheaper, and with slightly less
                            quality. Use this for exploring concepts quickly.
                            <Text size="xs" c="dimmed" mt={4}>
                              Requires generating in batches of 4
                            </Text>
                          </InfoPopover>
                        </div>
                      }
                    />
                  )}

                  {isOpenAI && (
                    <>
                      <InputSwitch
                        name="openAITransparentBackground"
                        label="Transparent Background"
                      />
                      <InputSelect
                        name="openAIQuality"
                        label="Quality"
                        data={['high', 'medium', 'low']}
                      />
                    </>
                  )}

                  {isFluxUltra && <InputSeed name="seed" label="Seed" />}
                  <div className="flex flex-col gap-1">
                    <Input.Label>Output Settings</Input.Label>
                    <div className="flex items-center gap-2">
                      <InputPreferredImageFormatCompact name="outputFormat" />
                      {!disablePriority && <InputRequestPriorityCompact name="priority" />}
                    </div>
                  </div>
                  {!disableAdvanced && (
                    <PersistentAccordion
                      storeKey="generation-form-advanced"
                      variant="contained"
                      className="mt-5"
                      classNames={{
                        item: classes.accordionItem,
                        control: classes.accordionControl,
                        content: classes.accordionContent,
                        label: classes.accordionLabel,
                      }}
                      transitionDuration={0}
                    >
                      <Accordion.Item value="advanced">
                        <Accordion.Control>
                          <Text size="sm" fw={590}>
                            Advanced
                          </Text>
                        </Accordion.Control>
                        <Accordion.Panel>
                          <div className="flex flex-col gap-3">
                            {!isDraft && (
                              <div className="relative flex flex-col gap-3">
                                {/* <LoadingOverlay
                            color={colorScheme === 'dark' ? theme.colors.dark[7] : '#fff'}
                            opacity={0.8}
                            m={-8}
                            radius="md"
                            loader={
                              <Text c="yellow" fw={500}>
                                Not available in Draft Mode
                              </Text>
                            }
                            zIndex={2}
                            visible={isDraft}
                          /> */}
                                {!disableCfgScale && (
                                  <InputNumberSlider
                                    name="cfgScale"
                                    label={
                                      <div className="flex items-center gap-1">
                                        <Input.Label>CFG Scale</Input.Label>
                                        <InfoPopover size="xs" iconProps={{ size: 14 }}>
                                          Controls how closely the image generation follows the text
                                          prompt.
                                        </InfoPopover>
                                      </div>
                                    }
                                    min={cfgScaleMin}
                                    max={cfgScaleMax}
                                    step={cfgScaleStep}
                                    precision={1}
                                    sliderProps={sharedSliderProps}
                                    numberProps={sharedNumberProps}
                                    presets={
                                      isFlux ||
                                      isQwen ||
                                      isFluxKontext ||
                                      isSD3 ||
                                      isChroma ||
                                      isZImageTurbo ||
                                      isFlux2 ||
                                      isPonyV7
                                        ? undefined
                                        : [
                                            { label: 'Creative', value: '4' },
                                            { label: 'Balanced', value: '7' },
                                            { label: 'Precise', value: '10' },
                                          ]
                                    }
                                    reverse
                                    disabled={cfgDisabled}
                                    data-testid="gen-cfg-scale"
                                  />
                                )}
                                {!disableSampler && (
                                  <InputSelect
                                    name="sampler"
                                    disabled={samplerDisabled}
                                    label={
                                      <div className="flex items-center gap-1">
                                        <Input.Label>Sampler</Input.Label>
                                        <InfoPopover size="xs" iconProps={{ size: 14 }}>
                                          Each will produce a slightly (or significantly) different
                                          image result.
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
                                {!disableSteps && (
                                  <Watch {...form} fields={['cfgScale', 'sampler']}>
                                    {({ cfgScale, sampler }) => {
                                      const castedSampler = sampler as keyof typeof samplerOffsets;
                                      const samplerOffset = samplerOffsets[castedSampler] ?? 0;
                                      const cfgOffset =
                                        Math.max(((cfgScale as number) ?? 0) - 4, 0) * 2;
                                      const samplerCfgOffset = samplerOffset + cfgOffset;

                                      return (
                                        <InputNumberSlider
                                          name="steps"
                                          disabled={stepsDisabled}
                                          description={
                                            isPonyV7
                                              ? 'This model works best when using 40 steps or more.'
                                              : undefined
                                          }
                                          label={
                                            <div className="flex items-center gap-1">
                                              <Input.Label>Steps</Input.Label>
                                              <InfoPopover size="xs" iconProps={{ size: 14 }}>
                                                The number of iterations spent generating an image.
                                              </InfoPopover>
                                            </div>
                                          }
                                          min={stepsMin}
                                          max={stepsMax}
                                          sliderProps={sharedSliderProps}
                                          numberProps={sharedNumberProps}
                                          presets={
                                            isFlux ||
                                            isQwen ||
                                            isSD3 ||
                                            isChroma ||
                                            isZImageTurbo ||
                                            isFlux2 ||
                                            isPonyV7
                                              ? undefined
                                              : [
                                                  {
                                                    label: 'Fast',
                                                    value: Math.round(
                                                      Number(10 + samplerCfgOffset)
                                                    ).toString(),
                                                  },
                                                  {
                                                    label: 'Balanced',
                                                    value: Math.round(
                                                      Number(20 + samplerCfgOffset)
                                                    ).toString(),
                                                  },
                                                  {
                                                    label: 'High',
                                                    value: Math.round(
                                                      Number(30 + samplerCfgOffset)
                                                    ).toString(),
                                                  },
                                                ]
                                          }
                                          reverse
                                          data-testid="gen-steps"
                                        />
                                      );
                                    }}
                                  </Watch>
                                )}
                              </div>
                            )}
                            {/* {!disableSafetyTolerance && (
                            <InputNumberSlider
                              name="safetyTolerance"
                              label="Safety Tolerance"
                              min={1}
                              max={6}
                              sliderProps={{
                                ...sharedSliderProps,
                                marks: flux1SafetyTolerance.map((_, index) => ({
                                  value: index + 1,
                                })),
                              }}
                              numberProps={sharedNumberProps}
                            />
                          )} */}
                            <InputSeed name="seed" label="Seed" />
                            {!disableClipSkip && (
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
                            {!disableDenoise && (
                              <InputNumberSlider
                                name="denoise"
                                label="Denoise"
                                min={minDenoise}
                                max={!isImg2Img ? 0.75 : 1}
                                step={0.05}
                              />
                            )}
                            {!disableVae && (
                              <InputResourceSelect
                                name="vae"
                                label={
                                  <div className="flex items-center gap-1">
                                    <Input.Label>{getDisplayName(ModelType.VAE)}</Input.Label>
                                    <InfoPopover size="xs" iconProps={{ size: 14 }}>
                                      These provide additional color and detail improvements.
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
                            {EXPERIMENTAL_MODE_SUPPORTED_MODELS.includes(
                              getBaseModelGroup(baseModel)
                            ) && (
                              <InputSwitch
                                name="enhancedCompatibility"
                                labelPosition="left"
                                label={
                                  <div className="relative flex items-center gap-1">
                                    <Input.Label>Enhanced Compatibility</Input.Label>
                                    <InfoPopover size="xs" iconProps={{ size: 14 }} withinPortal>
                                      {`We've updated our generation engine for better performance,
                                        but older prompts may look different. Turn this on to make
                                        new generations look more like your originals.`}
                                    </InfoPopover>
                                  </div>
                                }
                              />
                            )}
                          </div>
                          {/* <Text variant="link" onClick={() => {
                          const {prompt = '', negativePrompt = ''}= useGenerationStore.getState().data?.originalParams ?? {};
                          form.setValue('prompt', prompt)
                          form.setValue('negativePrompt', negativePrompt)
                        }}>Restore original prompt with weights?</Text> */}
                        </Accordion.Panel>
                      </Accordion.Item>
                    </PersistentAccordion>
                  )}
                </div>
                <div className="shadow-topper sticky bottom-0 z-10 mt-5 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
                  <DailyBoostRewardClaim />
                  <MembershipUpsell />
                  {promptWarning ? (
                    <div>
                      <Alert color="red" title="Prohibited Prompt">
                        <Text className="whitespace-pre-wrap ">{promptWarning}</Text>
                        <Button
                          color="red"
                          variant="light"
                          onClick={clearWarning}
                          style={{ marginTop: 10 }}
                          leftSection={<IconCheck />}
                          fullWidth
                        >
                          I Understand, Continue Generating
                        </Button>
                      </Alert>
                      {currentUser?.username && (
                        <Text size="xs" c="dimmed" mt={4}>
                          Is this a mistake?{' '}
                          <Text
                            component="a"
                            td="underline"
                            href={`https://forms.clickup.com/8459928/f/825mr-9671/KRFFR2BFKJCROV3B8Q?Civitai Username=${currentUser.username}`}
                            target="_blank"
                          >
                            Submit your prompt for review
                          </Text>{' '}
                          so we can refine our system.
                        </Text>
                      )}
                    </div>
                  ) : !status.available ? (
                    <AlertWithIcon
                      color="yellow"
                      title="Generation Status Alert"
                      icon={<IconAlertTriangle size={20} />}
                      iconColor="yellow"
                    >
                      {status.message}
                    </AlertWithIcon>
                  ) : (
                    <>
                      {!reviewed && (
                        <Alert color="yellow" title="Image Generation Terms" data-tour="gen:terms">
                          <Text size="xs">
                            By using the image generator you confirm that you have read and agree to
                            our{' '}
                            <Text component={Link} href="/content/tos" td="underline">
                              Terms of Service
                            </Text>{' '}
                            presented during onboarding. Failure to abide by{' '}
                            <Text component={Link} href="/safety#content-policies" td="underline">
                              our content policies
                            </Text>{' '}
                            will result in the loss of your access to the image generator. Illegal
                            or exploitative content will be removed and reported.
                          </Text>
                          <Button
                            color="yellow"
                            variant="light"
                            onClick={() => {
                              setReviewed(true);
                              if (running) helpers?.next();
                            }}
                            style={{ marginTop: 10 }}
                            leftSection={<IconCheck />}
                            fullWidth
                          >
                            I Confirm, Start Generating
                          </Button>
                        </Alert>
                      )}
                      {reviewed && (
                        <>
                          {!submitError ? (
                            <QueueSnackbar />
                          ) : (
                            <Notification
                              icon={<IconX size={18} />}
                              color="red"
                              onClose={() => setSubmitError(undefined)}
                              className="whitespace-pre-wrap rounded-md bg-red-8/20"
                            >
                              {submitError}
                            </Notification>
                          )}
                          <WhatIfAlert />
                          <div className="flex gap-2">
                            <Card withBorder className="flex max-w-[88px] flex-col p-0">
                              <Text className="pr-6 text-center text-xs font-semibold" c="dimmed">
                                Quantity
                              </Text>
                              <InputQuantity
                                name="quantity"
                                className={classes.generateButtonQuantityInput}
                                min={minQuantity}
                                max={maxQuantity}
                                step={minQuantity}
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
                          title="Generation Status Alert"
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
      </GenForm>
    </StepProvider>
  );
}

// #endregion

// #region [ready section]
function ReadySection() {
  const { data } = useTextToImageWhatIfContext();

  return data?.ready === false ? (
    <Card.Section m={0}>
      <Alert color="yellow" title="Potentially slow generation" radius={0}>
        <Text size="xs">
          {`We need to download additional resources to fulfill your request. This generation may take longer than usual to complete.`}
        </Text>
      </Alert>
    </Card.Section>
  ) : null;
}

// #endregion

function WhatIfAlert() {
  const { error } = useTextToImageWhatIfContext();
  if (!error) return null;

  return (
    <Alert color="yellow">
      {(error as any).message ?? 'Error calculating cost. Please try updating your values'}
    </Alert>
  );
}

// #region [submit button]
function SubmitButton(props: { isLoading?: boolean }) {
  const { data, isError, isInitialLoading } = useTextToImageWhatIfContext();
  const form = useGenerationForm();
  const features = useFeatureFlags();
  const { running, helpers } = useTourContext();
  const [baseModel, model, resources, vae] = form.watch(['baseModel', 'model', 'resources', 'vae']);
  const isFlux = getIsFlux(baseModel);
  const isFlux2 = getIsFlux2(model.id);
  const isSD3 = getIsSD3(baseModel);
  const isQwen = getIsQwen(model.id);
  const isOpenAI = baseModel === 'OpenAI';
  const checkpoint = model;
  const isSeedream = getIsSeedream(checkpoint.id);
  const isPonyV7 = getIsPonyV7(checkpoint.id);

  const hasCreatorTip =
    (!isFlux && !isFlux2 && !isQwen && !isSD3 && !isOpenAI && !isSeedream) ||
    [...(resources ?? []), vae].map((x) => (x ? x.id : undefined)).filter(isDefined).length > 0;

  const { creatorTip, civitaiTip } = useTipStore();
  if (!features.creatorComp) {
    tips.creators = 0;
    tips.civitai = 0;
  } else {
    tips.creators = hasCreatorTip ? creatorTip : 0;
    tips.civitai = civitaiTip;
  }

  const base = data?.cost?.base ?? 0;
  const totalTip = Math.ceil(base * tips.creators) + Math.ceil(base * tips.civitai);
  total = (data?.cost?.total ?? 0) + totalTip;

  const generateButton = (
    <GenerateButton
      type="submit"
      data-tour="gen:submit"
      className="h-full flex-1 px-2"
      loading={isInitialLoading || props.isLoading}
      cost={total}
      disabled={isError}
      onClick={() => {
        if (running) helpers?.next();
      }}
      transactions={data?.transactions}
      allowMatureContent={data?.allowMatureContent}
    />
  );

  if (!features.creatorComp) return generateButton;

  return (
    <div className="flex flex-1 items-center gap-1 rounded-md bg-gray-2 p-1 pr-1.5 dark:bg-dark-5">
      {generateButton}
      <GenerationCostPopover
        width={300}
        workflowCost={data?.cost ?? {}}
        hideCreatorTip={!hasCreatorTip}
      />
    </div>
  );
}

// #endregion

// #region [misc]
const sharedSliderProps: SliderProps = {
  size: 'sm',
};

const sharedNumberProps: NumberInputProps = {
  size: 'sm',
};

const getAspectRatioControls = (
  aspectRatios: { label: string; width: number; height: number }[]
) => {
  return aspectRatios.map(({ label, width, height }, index) => {
    const subLabel = `${width}x${height}`;
    return {
      label: (
        <Stack gap={2}>
          <Center>
            <Paper
              withBorder
              style={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 20 }}
            />
          </Center>
          <Stack gap={0}>
            <Text size="xs">{label}</Text>
            {label !== subLabel.replace('x', ':') && (
              <Text fz={10} c="dimmed">
                {subLabel}
              </Text>
            )}
          </Stack>
        </Stack>
      ),
      value: getRatio(width, height),
    };
  });
};

const clipSkipMarks = Array(10)
  .fill(0)
  .map((_, index) => ({ value: index + 1 }));
// #endregion
