import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import type { OrchestratorEngine2 } from '~/server/orchestrator/generation/generation.config';
import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';
import { useMemo, useState, useEffect, useRef } from 'react';
import { hashify } from '~/utils/string-helpers';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';

import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { useIsMutating } from '@tanstack/react-query';
import { Button, Notification } from '@mantine/core';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { BuzzTypeSelector, useSelectedBuzzType } from '~/components/generation_v2/FormFooter';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { useFormContext } from 'react-hook-form';
import { getQueryKey } from '@trpc/react-query';
import { trpc } from '~/utils/trpc';
import { IconX } from '@tabler/icons-react';
import { useVideoGenerationStore } from '~/components/Generation/Video/VideoGenerationProvider';
import { ViduFormInput } from './ViduFormInput';
import { WanFormInput } from '~/components/Generation/Video/WanFormInput/WanFormInput';
import { HunyuanFormInput } from '~/components/Generation/Video/HunyuanFormInput';
import { KlingFormInput } from '~/components/Generation/Video/KlingFormInput';
import { MinimaxFormInput } from '~/components/Generation/Video/MinimaxFormInput';
import { HaiperFormInput } from '~/components/Generation/Video/HaiperFormInput';
import { MochiFormInput } from '~/components/Generation/Video/MochiFormInput';
import { LightricksFormInput } from '~/components/Generation/Video/LightricksFormInput';
import { Ltx2FormInput } from '~/components/Generation/Video/Ltx2FormInput';
import { Veo3FormInput } from '~/components/Generation/Video/Veo3FormInput';
import { generationGraphStore, useGenerationGraphStore } from '~/store/generation-graph.store';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { isNewFormOnly } from '~/shared/data-graph/generation/config/workflows';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { WORKFLOW_TAGS, VID_QUANTITY_BY_TIER } from '~/shared/constants/generation.constants';
import { openSwitchToNewFormModal } from '~/components/generation_v2/SwitchToNewFormModal';
import { useLegacyGeneratorStore } from '~/store/legacy-generator.store';
import { GenForm } from '~/components/Generation/Form/GenForm';
import { StepProvider } from '~/components/Generation/Providers/StepProvider';
import { useDebouncer } from '~/utils/debouncer';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { useImagesUploadingStore } from '~/components/Generation/Input/SourceImageUploadMultiple';
import { usePromptFocusedStore } from '~/components/Generate/Input/InputPrompt';
import { SoraFormInput } from '~/components/Generation/Video/SoraFormInput';
import { MembershipUpsell } from '~/components/ImageGeneration/MembershipUpsell';
import { useGenerateFromGraph } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { generationFormStore } from '~/store/generation-form.store';
import {
  mapDataToGraphInput,
  mapGraphToLegacyParams,
  splitResourcesByType,
} from '~/server/services/orchestrator/legacy-metadata-mapper';
import { generationGraph, type GenerationCtx } from '~/shared/data-graph/generation';
import { removeEmpty } from '~/utils/object-helpers';
import { parseAIR, urnToModelType } from '~/shared/utils/air';
import { defaultWorkflowCost } from '~/shared/orchestrator/workflow-data';

/**
 * Keys excluded from whatIf queries — these don't affect cost estimation.
 * All other form values are passed through to the generation graph.
 */
const WHATIF_EXCLUDE_KEYS = new Set(['prompt', 'negativePrompt', 'seed', 'cfgScale']);

/** Build external context for generation graph from status */
function buildGraphContext(status: {
  limits: { quantity: number; resources: number };
  tier: string;
}): GenerationCtx {
  const tier = status.tier as GenerationCtx['user']['tier'];
  return {
    limits: {
      maxQuantity: status.limits.quantity,
      maxResources: status.limits.resources,
      vidQuantity: VID_QUANTITY_BY_TIER[tier] ?? 1,
    },
    user: {
      isMember: status.tier !== 'free',
      tier,
    },
  };
}

export function VideoGenerationForm({ engine }: { engine: OrchestratorEngine2 }) {
  const getState = useVideoGenerationStore((state) => state.getState);
  const storeData = useGenerationGraphStore((state) => state.data);
  const { trackAction } = useTrackEvent();

  const config = useMemo(() => videoGenerationConfig2[engine], [engine]);
  const status = useGenerationStatus();
  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : undefined),
    [status.message]
  );

  const [error, setError] = useState<string>();
  const [isLoadingDebounced, setIsLoadingDebounced] = useState(false);
  const { conditionalPerformTransaction } = useBuzzTransaction({
    accountTypes: buzzSpendTypes,
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const form = usePersistForm(`generation-form-${engine}`, {
    schema: config.validationSchema as any,
    version: 1.1,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    defaultValues: config.getDefaultValues(),
    storage: localStorage,
  });

  // Use shared hook with optimistic cache updates for queryGeneratedImages.
  // mutateAsync (not mutate) so handleSubmit can await the workflow.id and
  // emit Generator_JobLinked for the funnel dashboard's submit→job join.
  const { mutateAsync, isPending: isLoading } = useGenerateFromGraph({
    onError: (error) => {
      if (error.message && error.message.startsWith('Your prompt was flagged')) {
        form.setError('prompt', { type: 'custom', message: error.message }, { shouldFocus: true });
        const elem = document.getElementById(`input_prompt`);
        if (elem) elem.scrollIntoView();
      } else if (error.message) {
        setError(error.message);
      }
    },
  });

  function handleReset() {
    form.reset(config.getDefaultValues(), { keepDefaultValues: false });
  }

  function handleSubmit(data: Record<string, unknown>) {
    if (isLoading || isLoadingDebounced) return;
    setError(undefined);
    const { cost = 0 } = getState();

    // Per-attempt UUID re-used on the paired Generator_JobLinked emit after
    // mutateAsync resolves. Only present on the success-path emit (isValid:true);
    // fail-path emits leave it absent because no workflow row exists to link.
    const submitId = crypto.randomUUID();

    // Generation funnel telemetry — clicked Generate (video form). We fire
    // once after the inner graph.validate() resolves so isValid reflects
    // the actual outcome (the outer RHF onSubmit already passed at this
    // point). `formVersion: 'video'` discriminates from image legacy/new.
    //
    // `trackValid` guards the catch-block emit so a synchronous throw AFTER
    // a success-emit (e.g. a downstream `mapDataToGraphInput` mutation or
    // `mutate()` rejection) can't double-fire as a failure. We flip the
    // flag immediately after each emit site so the guard is meaningful.
    let trackValid = true;
    const emitSubmit = (isValid: boolean, modelVersionId?: number) => {
      try {
        const fromAction = useGenerationGraphStore.getState().lastEntryAction;
        trackAction({
          type: 'Generator_Submit',
          details: {
            // modelVersionId: callers pass `model.id` from the graph snapshot
            // (see `model = splitResourcesByType(...).model` below). The
            // snapshot's `model` IS the Checkpoint resource node; .id on a
            // resource node = ModelVersion.id, not the parent Model.id.
            modelVersionId,
            fromAction,
            formVersion: 'video',
            isValid,
            // Only attach submitId on the success path — fail emits have
            // nothing downstream to link to.
            ...(isValid ? { submitId } : {}),
          },
        }).catch(() => undefined);
      } catch {
        // Telemetry must never block a submission.
      }
      trackValid = false;
    };

    try {
      const validated = config.validate(data);
      setIsLoadingDebounced(true);

      // Transform via metadataFn (applies transformFn which sets correct baseModel/ecosystem)
      // then mapDataToGraphInput to convert to graph-compatible format
      const metadata = config.metadataFn(validated as any);
      const graphInput = mapDataToGraphInput(metadata as Record<string, unknown>, []);
      const parsedResources =
        'resources' in metadata && Array.isArray((metadata as any).resources)
          ? (metadata as any).resources.map((r: any) => {
              const parsed = parseAIR(r.air);
              return removeEmpty({
                id: r.id,
                model: { type: urnToModelType(parsed.type) },
                strength: r.strength,
              });
            })
          : [];

      const { model, resources: splitResources } = splitResourcesByType(parsedResources);
      graphInput.model = model;
      graphInput.resources = splitResources;

      // Clone generation graph, initialize with mapped data, and validate
      const graph = generationGraph.clone();
      const externalCtx = buildGraphContext(status);
      graph.init(removeEmpty(graphInput) as any, externalCtx);
      const result = graph.validate();

      if (!result.success) {
        console.error('Graph validation failed:', result.errors);
        setError('Validation failed. Please check your inputs.');
        setIsLoadingDebounced(false);
        emitSubmit(false, model?.id);
        return;
      }

      const graphData = result.data;
      emitSubmit(true, model?.id);

      const { buzzType } = generationFormStore.getState();
      // conditionalPerformTransaction takes `() => void` and does NOT await
      // the callback (see buzz.utils.ts:87 — `onPerformTransaction();`
      // discards the return). Wrap as a sync function that kicks off the
      // async work and explicitly swallows any unhandled rejection so it
      // can't bubble into the buzz-prompt wrapper's event-handler context.
      conditionalPerformTransaction(cost, () => {
        void (async () => {
          // mutateAsync (not mutate) so we can capture workflow.id and emit
          // Generator_JobLinked for the funnel dashboard's submit→job join.
          // Errors are still routed through the hook's onError handler; we
          // swallow the rejection here so the link emit doesn't fire on
          // failure paths (no workflow row to link to).
          const workflow = await mutateAsync({
            input: graphData,
            tags: [WORKFLOW_TAGS.SOURCE.LEGACY],
            ...(buzzType ? { buzzType } : {}),
          }).catch(() => undefined);
          if (workflow?.id) {
            trackAction({
              type: 'Generator_JobLinked',
              details: { submitId, workflowId: workflow.id },
            }).catch(() => undefined);
          }
        })().catch(() => undefined);
      });
    } catch (e: any) {
      // config.validate() threw — count as a failed submit attempt unless
      // we already emitted a success/failure for this submit cycle.
      if (trackValid) emitSubmit(false);
      console.error(e);
    }
    setTimeout(() => {
      setIsLoadingDebounced(false);
    }, 1000);
  }

  // Generation funnel telemetry — RHF validation-fail branch. Mirrors the
  // legacy form's handleSubmitError so video-form attempts that fail at the
  // react-hook-form level (zod resolver, required fields) are still counted.
  // The inner config.validate() + graph.validate() failures are already
  // captured from handleSubmit's emitSubmit; this fires for failures that
  // happen BEFORE handleSubmit runs.
  function handleSubmitError() {
    try {
      const fromAction = useGenerationGraphStore.getState().lastEntryAction;
      trackAction({
        type: 'Generator_Submit',
        details: {
          fromAction,
          formVersion: 'video',
          isValid: false,
        },
      }).catch(() => undefined);
    } catch {
      // Telemetry must never block UI.
    }
  }

  useEffect(() => {
    if (storeData && config) {
      const { params, resources, runType } = storeData;

      // Check if this data requires the new generation form
      const workflowKey = params.workflow as string | undefined;
      const ecosystemKey = params.ecosystem as string | undefined;
      const ecosystemId = ecosystemKey ? ecosystemByKey.get(ecosystemKey)?.id : undefined;
      const checkpointModelId = (resources as { id: number; model: { type: string } }[]).find(
        (r) => r.model.type === 'Checkpoint'
      )?.id;
      if (workflowKey && isNewFormOnly(workflowKey, ecosystemId, checkpointModelId)) {
        openSwitchToNewFormModal({
          onConfirm: () => {
            useLegacyGeneratorStore.getState().switchToNew();
          },
          onCancel: () => {
            generationGraphStore.clearData();
          },
        });
        return;
      }

      // Store params are in graph format (workflow, ecosystem, wanVersion).
      // Convert to legacy format (process, engine, version) for softValidate.
      let data = mapGraphToLegacyParams(params);
      if (runType === 'patch') {
        const formData = form.getValues();
        data = { ...formData, ...data };
      }
      const validated = config.softValidate(data);
      form.reset({ ...validated, resources }, { keepDefaultValues: true });

      generationGraphStore.clearData();
    }
  }, [storeData, config]);

  const baseModel = form.watch('baseModel');
  const stepProviderValue = useMemo(() => ({ baseModel }), [baseModel]);

  const InputsComponent = inputDictionary[engine];
  if (!InputsComponent)
    return <div className="flex items-center justify-center p-3">Form not implemented</div>;

  return (
    <StepProvider value={stepProviderValue}>
      <GenForm
        form={form}
        onSubmit={handleSubmit}
        onError={handleSubmitError}
        track
        className="relative flex h-full flex-1 flex-col justify-between gap-2"
      >
        <div className="flex flex-col gap-3 px-2">
          <InputsComponent />
        </div>
        <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
          <DailyBoostRewardClaim />
          <MembershipUpsell />
          {!error ? (
            <QueueSnackbar />
          ) : (
            <Notification
              icon={<IconX size={18} />}
              color="red"
              onClose={() => setError(undefined)}
              className="rounded-md bg-red-8/20"
            >
              {error}
            </Notification>
          )}
          <div className="flex gap-2">
            <SubmitButton2
              loading={isLoading || isLoadingDebounced}
              engine={engine}
              setError={setError}
            />
            <Button onClick={handleReset} variant="default" className="h-auto px-3">
              Reset
            </Button>
          </div>
          {status.message && !status.isLoading && (
            <DismissibleAlert
              color="yellow"
              title="Generation Status Alert"
              id={messageHash}
              storage="sessionStorage"
              getInitialValueInEffect={false}
            >
              <CustomMarkdown allowedElements={['a', 'strong']} unwrapDisallowed>
                {status.message}
              </CustomMarkdown>
            </DismissibleAlert>
          )}
        </div>
      </GenForm>
    </StepProvider>
  );
}

function SubmitButton2({
  loading,
  engine,
  setError,
}: {
  loading: boolean;
  engine: OrchestratorEngine2;
  setError: (error?: string) => void;
}) {
  const setState = useVideoGenerationStore((state) => state.setState);
  const status = useGenerationStatus();
  const config = videoGenerationConfig2[engine];
  const [query, setQuery] = useState<Record<string, any> | null>(null);
  const [canQuery, setCanQuery] = useState(false);
  const { getValues, watch } = useFormContext();
  const isUploadingImageValue = useIsMutating({
    mutationKey: getQueryKey(trpc.orchestrator.imageUpload),
  });
  const isUploadingMultiple = useImagesUploadingStore((state) => state.uploading.length > 0);
  const isUploadingImage = isUploadingImageValue === 1 || isUploadingMultiple;

  // Use whatIfFromGraph instead of legacy whatIf route
  const {
    data: queryData,
    isFetching,
    error,
  } = trpc.orchestrator.whatIfFromGraph.useQuery(query!, {
    enabled: !!query && !isUploadingImage && canQuery,
  });

  const data = useMemo(
    () =>
      queryData ?? {
        cost: defaultWorkflowCost,
        ready: false,
        allowMatureContent: false,
        transactions: undefined,
      },
    [queryData]
  );

  useEffect(() => {
    setError(error?.message);
  }, [error]);

  const cost = data.cost?.total ?? 0;
  const totalCost = cost;
  const debouncer = useDebouncer(150);

  const promptRef = useRef('');
  const promptFocused = usePromptFocusedStore((x) => x.focused);

  useEffect(() => {
    function handleFormData() {
      debouncer(() => {
        const formData = getValues();
        // Pass all form values except keys that don't affect cost/validation
        const whatIfData = Object.fromEntries(
          Object.entries(formData).filter(([key]) => !WHATIF_EXCLUDE_KEYS.has(key))
        );

        try {
          const result = config.getWhatIfValues(whatIfData);

          // Strip image data from resources (not needed for whatIf)
          if ('resources' in result && !!result.resources)
            result.resources = (result.resources! as Record<string, any>[]).map(
              ({ image, ...resource }) => resource
            ) as any;

          // Read prompt from form data directly — result.prompt is always empty
          // since prompt is excluded from whatIfData via WHATIF_EXCLUDE_KEYS
          if (!promptFocused) {
            promptRef.current = formData.prompt ?? '';
          }

          // Transform via metadataFn (applies transformFn which sets correct baseModel/ecosystem)
          // then mapDataToGraphInput to convert to graph-compatible format
          const metadata = config.metadataFn({
            ...result,
            prompt: promptRef.current,
          } as any);
          const graphInput = mapDataToGraphInput(metadata as Record<string, unknown>, []);
          const parsedResources =
            'resources' in metadata && Array.isArray((metadata as any).resources)
              ? (metadata as any).resources.map((r: any) => {
                  const parsed = parseAIR(r.air);
                  return removeEmpty({
                    id: r.id,
                    model: { type: urnToModelType(parsed.type) },
                    strength: r.strength,
                  });
                })
              : [];

          const { model, resources: splitResources } = splitResourcesByType(parsedResources);
          graphInput.model = model;
          graphInput.resources = splitResources;

          // Clone generation graph, initialize with mapped data, and validate partial
          // validatePartial returns valid data even if some nodes fail (useful for whatIf)
          const graph = generationGraph.clone();
          const externalCtx = buildGraphContext(status);
          graph.init(removeEmpty(graphInput) as any, externalCtx);
          const { data: graphData } = graph.validatePartial();

          setQuery(graphData);
        } catch (e: any) {
          console.log({ e });
          setQuery(null);
        }
      });
    }
    handleFormData();
    const subscription = watch(() => {
      handleFormData();
    });
    return subscription.unsubscribe;
  }, [engine, promptFocused]);

  useEffect(() => {
    setTimeout(() => {
      setCanQuery(true);
    }, 1000);
  }, []);

  useEffect(() => {
    setState({ cost: data.cost?.base ?? undefined });
  }, [data]);

  const { selectedType } = useSelectedBuzzType();
  const { color } = useBuzzCurrencyConfig(selectedType);

  return (
    <Button.Group className="flex-1">
      <GenerateButton
        type="submit"
        className="flex-1"
        color={color}
        disabled={!query || isUploadingImage}
        loading={isFetching || loading}
      >
        Generate
      </GenerateButton>
      <BuzzTypeSelector cost={totalCost} loading={isFetching} />
    </Button.Group>
  );
}

const inputDictionary: Partial<Record<OrchestratorEngine2, () => JSX.Element>> = {
  veo3: Veo3FormInput,
  vidu: ViduFormInput,
  wan: WanFormInput,
  hunyuan: HunyuanFormInput,
  kling: KlingFormInput,
  minimax: MinimaxFormInput,
  haiper: HaiperFormInput,
  mochi: MochiFormInput,
  lightricks: LightricksFormInput,
  ltx2: Ltx2FormInput,
  sora: SoraFormInput,
};
