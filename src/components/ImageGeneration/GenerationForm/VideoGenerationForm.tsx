import { Button, Input, Text, Select, Alert, Loader } from '@mantine/core';
import React, { createContext, useEffect, useState, useContext, useMemo } from 'react';
import { UseFormReturn, useFormContext } from 'react-hook-form';
import { z } from 'zod';
import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { HaiperAspectRatio } from '~/components/ImageGeneration/GenerationForm/HaiperAspectRatio';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { Form, InputSegmentedControl, InputSwitch, InputText, InputTextArea } from '~/libs/form';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import {
  VideoGenerationInput,
  VideoGenerationSchema,
  videoGenerationSchema,
} from '~/server/schema/orchestrator/orchestrator.schema';
import { trpc } from '~/utils/trpc';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { useGenerate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import { create } from 'zustand';
import {
  generationStore,
  useGenerationFormStore,
  generationFormStore,
  useGenerationFormWorkflowConfig,
  useGenerationStore,
} from '~/store/generation.store';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import {
  WORKFLOW_TAGS,
  generationFormWorkflowConfigurations,
} from '~/shared/constants/generation.constants';
import { showErrorNotification } from '~/utils/notifications';
import { InputImageUrl } from '~/components/Generate/Input/InputImageUrl';
import { GenerationWorkflowConfig } from '~/shared/types/generation.types';
import { TwCard } from '~/components/TwCard/TwCard';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { hashify } from '~/utils/string-helpers';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { useGetGenerationEngines } from '~/components/Generate/hooks/useGetGenerationEngines';
import { useGetAvailableGenerationEngineConfigurations } from '~/components/Generate/hooks/useGetAvailableGenerationEngineConfigurations';

const schema = videoGenerationSchema;

const WorkflowContext = createContext<{ workflow: GenerationWorkflowConfig } | null>(null);
function useWorkflowContext() {
  const ctx = useContext(WorkflowContext);
  if (!ctx) throw new Error('missing video gen ctx');
  return ctx;
}

export function VideoGenerationForm() {
  const engine = useGenerationFormStore((state) => state.engine ?? 'haiper');

  const { workflow, availableWorkflows } = useGenerationFormWorkflowConfig({
    type: 'video',
    category: 'service',
    engine,
  });

  const { data: engines, isLoading } = useGetGenerationEngines();
  const engineData = engines?.find((x) => x.engine === engine);

  // TODO - handle case where workflow is no longer available
  if (!workflow) return null;

  const workflows =
    workflow.subType === 'txt2vid'
      ? availableWorkflows.filter((x) => x.subType === 'txt2vid')
      : availableWorkflows;

  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex flex-col gap-2 px-3">
        <Alert>
          <Text>
            Learn more about{' '}
            <Text
              component="a"
              variant="link"
              href="https://education.civitai.com/civitais-guide-to-video-in-the-civitai-generator"
              target="blank"
              inline
            >
              video generation
            </Text>
          </Text>
          <Text size="xs" color="dimmed">
            Note: this is an experimental build. Pricing, default settings, and results are subject
            to change.
          </Text>
        </Alert>
        <Select
          label="Tool"
          value={engine}
          onChange={(value) => generationFormStore.setEngine(value!)}
          data={[
            { label: 'Haiper', value: 'haiper' },
            { label: 'Mochi', value: 'mochi' },
          ]}
        />
        {engineData?.message && !engineData?.disabled && (
          <Alert color="blue">{engineData.message}</Alert>
        )}
        {workflows.length > 1 ? (
          <Select
            label="Workflow"
            data={workflows.map((x) => ({ label: x.name, value: x.key }))}
            value={workflow.key ?? workflows[0].key}
            onChange={(workflow) => generationFormStore.setWorkflow(workflow!)}
          />
        ) : (
          <div>
            <Input.Label>Workflow</Input.Label>
            <TwCard className="border px-3 py-2">
              <Text size="sm" className="leading-5">
                {workflow.name}
              </Text>
            </TwCard>
          </div>
        )}
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center p-3">
          <Loader />
        </div>
      ) : engineData?.disabled ? (
        <Alert color="yellow" className="mx-3" title={`${engine} generation disabled`}>
          {engineData?.message && <Text className="mb-2">{engineData?.message}</Text>}
          {engines && (
            <>
              <Text className="mb-1">Try out another of our generation tools</Text>
              <div className="flex flex-wrap gap-2">
                {engines
                  .filter((x) => !x.disabled)
                  .map(({ engine }) => (
                    <Button
                      key={engine}
                      compact
                      onClick={() => generationFormStore.setEngine(engine)}
                    >
                      {engine}
                    </Button>
                  ))}
              </div>
            </>
          )}
        </Alert>
      ) : (
        <WorkflowContext.Provider value={{ workflow }}>
          <EngineForm />
        </WorkflowContext.Provider>
      )}
    </div>
  );
}

function EngineForm() {
  const { workflow } = useWorkflowContext();
  switch (workflow.key) {
    case 'haiper-txt2vid':
      return <HaiperTxt2VidGenerationForm />;
    case 'haiper-img2vid':
      return <HaiperImg2VidGenerationForm />;
    case 'mochi-txt2vid':
      return <MochiGenerationForm />;
    default:
      return null;
  }
}

function HaiperTxt2VidGenerationForm() {
  return (
    <FormWrapper engine="haiper">
      <InputTextArea name="prompt" label="Prompt" placeholder="Your prompt goes here..." autosize />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
      <HaiperAspectRatio name="aspectRatio" label="Aspect Ratio" />
      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={[2, 4, 8].map((value) => ({ label: `${value}s`, value }))}
        />
      </div>
      <InputSeed name="seed" label="Seed" />
    </FormWrapper>
  );
}

function HaiperImg2VidGenerationForm() {
  return (
    <FormWrapper engine="haiper">
      <InputImageUrl name="sourceImageUrl" label="Image" />
      <InputTextArea name="prompt" label="Prompt" placeholder="Your prompt goes here..." autosize />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={[2, 4, 8].map((value) => ({ label: `${value}s`, value }))}
        />
      </div>
      <InputSeed name="seed" label="Seed" />
    </FormWrapper>
  );
}

function MochiGenerationForm() {
  return (
    <FormWrapper engine="mochi">
      <InputTextArea name="prompt" label="Prompt" placeholder="Your prompt goes here..." autosize />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
      <DescriptionTable
        items={[
          { label: 'Aspect Ratio', value: '16:9' },
          { label: 'Resolution', value: '848x480 (480p)' },
          { label: 'Duration', value: '5s' },
        ]}
      />
      <InputSeed name="seed" label="Seed" />
    </FormWrapper>
  );
}

type Engine = VideoGenerationInput['engine'];
function FormWrapper({
  engine,
  children,
}: {
  engine: Engine;
  children: React.ReactNode | ((form: UseFormReturn) => React.ReactNode);
}) {
  const type = useGenerationFormStore((state) => state.type);
  const storeData = useGenerationStore((state) => state.data);
  const { workflow } = useWorkflowContext();
  const { defaultValues } = workflow ?? {};
  const status = useGenerationStatus();
  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : undefined),
    [status.message]
  );

  const { data: availableEngineConfigurations } = useGetAvailableGenerationEngineConfigurations();

  const form = usePersistForm(workflow.key, {
    schema: schema as any,
    version: 1,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    defaultValues: { ...defaultValues, engine, workflow: workflow.key },
    storage: localStorage,
  });

  const { mutate, isLoading, error } = useGenerate();
  const { conditionalPerformTransaction } = useBuzzTransaction({
    type: 'Generation',
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  function handleReset() {
    for (const workflow of generationFormWorkflowConfigurations) {
      localStorage.removeItem(workflow.key);
    }
    form.reset(defaultValues);
    const engineConfig = availableEngineConfigurations?.[0];
    if (engineConfig) generationFormStore.setWorkflow(engineConfig.key);
  }

  function handleSubmit(data: z.infer<typeof schema>) {
    if (isLoading) return;

    const { cost } = useCostStore.getState();
    const totalCost = cost;
    // TODO - tips?
    conditionalPerformTransaction(totalCost, () => {
      mutate({
        type: 'video',
        data: { ...data, engine, workflow: workflow.key },
        tags: [WORKFLOW_TAGS.VIDEO, workflow.subType, workflow.key],
      });
    });
  }

  useEffect(() => {
    if (type === 'video' && storeData) {
      const registered = Object.keys(form.getValues());
      const { params } = storeData;
      for (const [key, value] of Object.entries(params)) {
        if (registered.includes(key) && key !== 'engine') form.setValue(key as any, value);
      }
      generationStore.clearData();
    }
  }, [storeData, type]);

  useEffect(() => {
    if (!error) return;
    if (error.message.startsWith('Your prompt was flagged')) {
      form.setError('prompt', { type: 'custom', message: error.message }, { shouldFocus: true });
      const elem = document.getElementById(`input_prompt`);
      if (elem) elem.scrollIntoView();
    } else
      showErrorNotification({
        title: 'Failed to generate',
        error: new Error(error.message),
        reason: error.message ?? 'An unexpected error occurred. Please try again later.',
      });
  }, [error]);

  return (
    <Form
      form={form as any}
      onSubmit={handleSubmit}
      // onError={(error) => console.log({ error, values: form.getValues() })}
      className="relative flex h-full flex-1 flex-col justify-between gap-2"
    >
      <div className="flex flex-col gap-2 px-3">
        <InputText type="hidden" name="engine" value={engine} className="hidden" />
        <InputText type="hidden" name="workflow" value={workflow.key} className="hidden" />

        {typeof children === 'function' ? children(form) : children}
      </div>
      <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
        <DailyBoostRewardClaim />
        <QueueSnackbar />
        <div className="flex gap-2">
          <SubmitButton2 loading={isLoading} engine={engine} />
          <Button onClick={handleReset} variant="default" className="h-auto px-3">
            Reset
          </Button>
        </div>
        {status.message && !status.isLoading && (
          <DismissibleAlert
            color="yellow"
            title="Image Generation Status Alert"
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

function SubmitButton2({ loading, engine }: { loading: boolean; engine: Engine }) {
  const [query, setQuery] = useState<VideoGenerationSchema | null>(null);
  const { getValues, watch } = useFormContext();
  const { data, isFetching } = trpc.orchestrator.whatIf.useQuery(
    { type: 'video', data: query as VideoGenerationSchema },
    { keepPreviousData: false, enabled: !!query }
  );
  const { workflow } = useWorkflowContext();
  // console.log({ query, workflow, engine });

  const cost = data?.cost?.total ?? 0;
  const totalCost = cost; //variable placeholder to allow adding tips // TODO - include tips in whatif query

  useEffect(() => {
    const { whatIf = [] } = engines[engine] ?? {};
    const { defaultValues } = workflow;
    const subscription = watch(() => {
      const formData = getValues();
      const whatIfData = whatIf.reduce<Record<string, unknown>>(
        (acc, prop) => ({ ...acc, [prop]: formData[prop] }),
        {}
      );

      const result = schema.safeParse({
        engine,
        workflow: workflow.key,
        ...defaultValues,
        ...whatIfData,
      });
      if (!result.success) setQuery(null);
      else setQuery(result.data);
    });
    return subscription.unsubscribe;
  }, [workflow, engine]);

  useEffect(() => {
    if (data?.cost?.base) {
      useCostStore.setState({ cost: data.cost.base });
    }
  }, [data]);

  return (
    <GenerateButton
      type="submit"
      className="flex-1"
      disabled={!data || !query}
      loading={isFetching || loading}
      cost={totalCost}
    >
      Generate
    </GenerateButton>
  );
}

const useCostStore = create<{ cost: number }>(() => ({ cost: 0 }));

type EnginesDictionary = Record<
  string,
  {
    label: string;
    description: string | (() => React.ReactNode);
    whatIf?: string[];
  }
>;
const engines: EnginesDictionary = {
  haiper: {
    label: 'Haiper',
    description: `Generate hyper-realistic and stunning videos with Haiper's next-gen 2.0 model!`,
    whatIf: ['duration'],
  },
  mochi: {
    label: 'Mochi',
    description() {
      return (
        <>
          Mochi 1 preview, by creators{' '}
          <Text
            variant="link"
            component="a"
            rel="nofollow"
            href="https://www.genmo.ai/"
            target="_blank"
          >
            https://www.genmo.ai/
          </Text>
          , is an open state-of-the-art video generation model with high-fidelity motion and strong
          prompt adherence in preliminary evaluation.
        </>
      );
    },
  },
};
