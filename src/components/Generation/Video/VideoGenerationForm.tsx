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
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { useFormContext } from 'react-hook-form';
import { getQueryKey } from '@trpc/react-query';
import { trpc } from '~/utils/trpc';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
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
import { GenForm } from '~/components/Generation/Form/GenForm';
import { StepProvider } from '~/components/Generation/Providers/StepProvider';
import { useDebouncer } from '~/utils/debouncer';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { useImagesUploadingStore } from '~/components/Generation/Input/SourceImageUploadMultiple';
import { usePromptFocusedStore } from '~/components/Generate/Input/InputPrompt';
import { SoraFormInput } from '~/components/Generation/Video/SoraFormInput';
import { MembershipUpsell } from '~/components/ImageGeneration/MembershipUpsell';
import { useGenerateFromGraph } from '~/components/ImageGeneration/utils/generationRequestHooks';
import {
  mapDataToGraphInput,
  mapGraphToLegacyParams,
  splitResourcesByType,
} from '~/server/services/orchestrator/legacy-metadata-mapper';
import { generationGraph, type GenerationCtx } from '~/shared/data-graph/generation';
import { removeEmpty } from '~/utils/object-helpers';
import { parseAIR } from '~/shared/utils/air';

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
  return {
    limits: {
      maxQuantity: status.limits.quantity,
      maxResources: status.limits.resources,
    },
    user: {
      isMember: status.tier !== 'free',
      tier: status.tier as GenerationCtx['user']['tier'],
    },
  };
}

export function VideoGenerationForm({ engine }: { engine: OrchestratorEngine2 }) {
  const getState = useVideoGenerationStore((state) => state.getState);
  const storeData = useGenerationGraphStore((state) => state.data);

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

  // Use shared hook with optimistic cache updates for queryGeneratedImages
  const { mutate, isPending: isLoading } = useGenerateFromGraph({
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
                model: { type: parsed.type },
                strength: r.strength,
              });
            })
          : [];

      const { model, resources: splitResources } = splitResourcesByType(parsedResources);
      graphInput.model = model;
      graphInput.resources = splitResources;

      console.log({ graphInput });

      // Clone generation graph, initialize with mapped data, and validate
      const graph = generationGraph.clone();
      const externalCtx = buildGraphContext(status);
      graph.init(removeEmpty(graphInput) as any, externalCtx);
      const result = graph.validate();

      if (!result.success) {
        console.error('Graph validation failed:', result.errors);
        setError('Validation failed. Please check your inputs.');
        setIsLoadingDebounced(false);
        return;
      }

      const graphData = result.data;

      console.log({ graphData });

      conditionalPerformTransaction(cost, () => {
        mutate({
          input: graphData,
        });
      });
    } catch (e: any) {
      console.error(e);
    }
    setTimeout(() => {
      setIsLoadingDebounced(false);
    }, 1000);
  }

  useEffect(() => {
    if (storeData && config) {
      const { params, resources, runType } = storeData;
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
  const { data, isFetching, error } = trpc.orchestrator.whatIfFromGraph.useQuery(query!, {
    enabled: !!query && !isUploadingImage && canQuery,
  });

  useEffect(() => {
    setError(error?.message);
  }, [error]);

  const cost = data?.cost?.total ?? 0;
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

          if (!promptFocused && result.prompt !== undefined) {
            promptRef.current = result.prompt!;
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
                    model: { type: parsed.type },
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
    setState({ cost: data?.cost?.base ?? undefined });
  }, [data]);

  return (
    <div className="flex flex-1 items-center gap-1 rounded-md bg-gray-2 p-1 pr-1.5 dark:bg-dark-5">
      <GenerateButton
        type="submit"
        className="flex-1"
        disabled={!data || !query || isUploadingImage}
        loading={isFetching || loading}
        cost={totalCost}
        transactions={data?.transactions}
        allowMatureContent={data?.allowMatureContent}
      >
        Generate
      </GenerateButton>
      <GenerationCostPopover
        width={300}
        workflowCost={data?.cost ?? {}}
        hideCreatorTip
        hideCivitaiTip
      />
    </div>
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
