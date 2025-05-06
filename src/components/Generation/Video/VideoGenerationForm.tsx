import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import {
  OrchestratorEngine2,
  videoGenerationConfig2,
} from '~/server/orchestrator/generation/generation.config';
import { useMemo, useState, useEffect } from 'react';
import { hashify } from '~/utils/string-helpers';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import { useGenerate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { InputRequestPriority } from '~/components/Generation/Input/RequestPriority';
import { Form } from '~/libs/form';
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
import { WanFormInput } from '~/components/Generation/Video/WanFormInput';
import { HunyuanFormInput } from '~/components/Generation/Video/HunyuanFormInput';
import { KlingFormInput } from '~/components/Generation/Video/KlingFormInput';
import { MinimaxFormInput } from '~/components/Generation/Video/MinimaxFormInput';
import { HaiperFormInput } from '~/components/Generation/Video/HaiperFormInput';

export function VideoGenerationForm() {
  const getState = useVideoGenerationStore((state) => state.getState);
  const engine = useVideoGenerationStore((state) => state.engine);

  const config = videoGenerationConfig2[engine];
  const status = useGenerationStatus();
  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : undefined),
    [status.message]
  );

  const [error, setError] = useState<string>();
  const [isLoadingDebounced, setIsLoadingDebounced] = useState(false);
  const { conditionalPerformTransaction } = useBuzzTransaction({
    type: 'Generation',
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const form = usePersistForm(`generation-form-${engine}`, {
    schema: config.validationSchema as any,
    version: 1,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    defaultValues: config.getDefaultValues(),
    storage: localStorage,
  });

  const { mutate, isLoading } = useGenerate({
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
    form.reset(config.getDefaultValues());
  }

  function handleSubmit(data: Record<string, unknown>) {
    if (isLoading || isLoadingDebounced) return;
    setError(undefined);
    // will we ever have free generation again?
    const { cost = 0 } = getState();
    try {
      const validated = config.validate(data);
      setIsLoadingDebounced(true);
      conditionalPerformTransaction(cost, () => {
        mutate({
          $type: 'videoGen',
          data: validated,
          tags: [WORKFLOW_TAGS.VIDEO, engine],
        });
      });
    } catch (e: any) {
      console.error(e);
    }
    setTimeout(() => {
      setIsLoadingDebounced(false);
    }, 1000);
  }

  const InputsComponent = inputDictionary[engine];
  if (!InputsComponent)
    return <div className="flex items-center justify-center p-3">Form not implemented</div>;

  return (
    <Form
      form={form}
      onSubmit={handleSubmit}
      className="relative flex h-full flex-1 flex-col justify-between gap-2"
    >
      <InputsComponent />
      <InputRequestPriority name="priority" label="Request Priority" modifier="multiplier" />
      <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
        <DailyBoostRewardClaim />
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
          <SubmitButton2 loading={isLoading || isLoadingDebounced} />
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
    </Form>
  );
}

function SubmitButton2({ loading }: { loading: boolean }) {
  const engine = useVideoGenerationStore((state) => state.engine);
  const setState = useVideoGenerationStore((state) => state.setState);
  const config = videoGenerationConfig2[engine];
  const [query, setQuery] = useState<Record<string, any> | null>(null);
  const { getValues, watch } = useFormContext();
  const [error, setError] = useState<string | null>(null);
  const isUploadingImageValue = useIsMutating({
    mutationKey: getQueryKey(trpc.orchestrator.imageUpload),
  });
  const isUploadingImage = isUploadingImageValue === 1;
  const { data, isFetching } = trpc.orchestrator.whatIf.useQuery(
    { $type: 'videoGen', data: query as Record<string, any> },
    { keepPreviousData: false, enabled: !!query && !isUploadingImage }
  );

  const cost = data?.cost?.total ?? 0;
  const totalCost = cost; //variable placeholder to allow adding tips // TODO - include tips in whatif query

  useEffect(() => {
    const subscription = watch(() => {
      const formData = getValues();
      const whatIfData = config.whatIfProps.reduce<Record<string, unknown>>(
        (acc, prop) => ({ ...acc, [prop]: formData[prop] }),
        {}
      );

      try {
        const result = config.getWhatIfValues({ ...whatIfData, priority: formData.priority });
        setQuery(result);
        setError(null);
      } catch (e: any) {
        const { message, path } = JSON.parse(e.message)?.[0] as any;
        setQuery(null);
        setError(`${path?.[0]}: ${message}`);
      }
    });
    return subscription.unsubscribe;
  }, [engine]);

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
      >
        Generate
      </GenerateButton>
      <GenerationCostPopover width={300} workflowCost={data?.cost ?? {}} hideCreatorTip />
    </div>
  );
}

const inputDictionary: Record<OrchestratorEngine2, () => JSX.Element> = {
  vidu: ViduFormInput,
  wan: WanFormInput,
  hunyuan: HunyuanFormInput,
  kling: KlingFormInput,
  minimax: MinimaxFormInput,
  haiper: HaiperFormInput,
};
