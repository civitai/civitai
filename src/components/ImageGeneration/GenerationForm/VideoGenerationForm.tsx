import { Button, Input, Text, Select, Alert, Loader, Anchor } from '@mantine/core';
import React, { createContext, useEffect, useState, useContext, useMemo } from 'react';
import { UseFormReturn, useFormContext } from 'react-hook-form';
import { z } from 'zod';
import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { HaiperAspectRatio } from '~/components/ImageGeneration/GenerationForm/HaiperAspectRatio';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import {
  Form,
  InputNumberSlider,
  InputSegmentedControl,
  InputSwitch,
  InputText,
  InputTextArea,
} from '~/libs/form';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
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
  useGenerationStore,
  useVideoGenerationWorkflows,
  useSelectedVideoWorkflow,
} from '~/store/generation.store';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import {
  WORKFLOW_TAGS,
  engineDefinitions,
  generationFormWorkflowConfigurations,
} from '~/shared/constants/generation.constants';
import { showErrorNotification } from '~/utils/notifications';
import {
  AccordionGeneratorImageInput,
  GeneratorImageInput,
} from '~/components/Generate/Input/GeneratorImageInput';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { getDisplayName, hashify } from '~/utils/string-helpers';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { KlingMode } from '@civitai/client';
import { type OrchestratorEngine } from '~/server/orchestrator/infrastructure/base.enums';
import { haiperDuration } from '~/server/orchestrator/haiper/haiper.schema';
import { klingAspectRatios, klingDuration } from '~/server/orchestrator/kling/kling.schema';
import { VideoGenerationSchema } from '~/server/orchestrator/generation/generation.config';
import { VideoGenerationConfig } from '~/server/orchestrator/infrastructure/GenerationConfig';
import { useIsMutating } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { uniqBy } from 'lodash-es';
import {
  lightricksAspectRatios,
  lightricksDuration,
} from '~/server/orchestrator/lightricks/lightricks.schema';
import { InputRequestPriority } from '~/components/Generation/Input/RequestPriority';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';

const WorkflowContext = createContext<{
  workflow: VideoGenerationConfig;
  engine: string;
} | null>(null);
function useWorkflowContext() {
  const ctx = useContext(WorkflowContext);
  if (!ctx) throw new Error('missing video gen ctx');
  return ctx;
}

export function VideoGenerationForm() {
  const { data: workflows, availableEngines, isLoading } = useVideoGenerationWorkflows();
  const workflow = useSelectedVideoWorkflow();
  const sourceImage = useGenerationFormStore((state) => state.sourceImage);

  const engineHasImg2Vid = workflows.some(
    (x) => x.engine === workflow.engine && x.subType === 'img2vid'
  );

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
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center p-3">
          <Loader />
        </div>
      ) : workflow?.disabled ? (
        <Alert
          color="yellow"
          className="mx-3"
          title={<span className="capitalize">{`${workflow?.engine} generation disabled`}</span>}
        >
          {workflow?.message && <Text className="mb-2">{workflow?.message}</Text>}
          {workflows && (
            <>
              <Text className="mb-1">Try out another video generation tool:</Text>
              <div className="flex flex-wrap gap-2">
                {uniqBy(
                  workflows.filter((x) => !x.disabled),
                  'engine'
                ).map(({ engine }) => (
                  <Button
                    key={engine}
                    compact
                    onClick={() => generationFormStore.setEngine(engine)}
                    variant="outline"
                    color="yellow"
                    className="capitalize"
                  >
                    {getDisplayName(engine)}
                  </Button>
                ))}
              </div>
            </>
          )}
        </Alert>
      ) : workflow ? (
        <>
          <div className="flex flex-col gap-2 px-3">
            <Select
              label="Tool"
              value={workflow.engine}
              description={workflow?.message && !workflow?.disabled ? workflow.message : undefined}
              onChange={(value) => generationFormStore.setEngine(value!)}
              data={availableEngines?.map(({ key, label }) => ({ label, value: key }))}
            />
            {engineHasImg2Vid && (
              <AccordionGeneratorImageInput
                value={sourceImage}
                onChange={generationFormStore.setsourceImage}
              />
            )}
          </div>
          <WorkflowContext.Provider value={{ workflow, engine: workflow.engine }}>
            <EngineForm />
          </WorkflowContext.Provider>
        </>
      ) : null}
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
    case 'kling-txt2vid':
      return <KlingTextToVideoForm />;
    case 'kling-img2vid':
      return <KlingImageToVideoForm />;
    case 'minimax-txt2vid':
      return <MinimaxTxt2VidGenerationForm />;
    case 'minimax-img2vid':
      return <MinimaxImg2VidGenerationForm />;
    case 'lightricks-txt2vid':
      return <LightricksTxt2VidGenerationForm />;
    case 'lightricks-img2vid':
      return <LightricksImg2VidGenerationForm />;
    default:
      return null;
  }
}

function KlingTextToVideoForm() {
  return (
    <FormWrapper engine="kling">
      <InputTextArea
        required
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
      <InputAspectRatioColonDelimited
        name="aspectRatio"
        label="Aspect Ratio"
        options={klingAspectRatios}
      />

      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={klingDuration.map((value) => ({
            label: `${value}s`,
            value,
          }))}
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <Input.Label>Mode</Input.Label>
          <InfoPopover size="xs" iconProps={{ size: 14 }}>
            Standard mode is faster to generate and more cost-effective. Pro takes longer to
            generate and has higher quality video output.
          </InfoPopover>
        </div>
        <InputSegmentedControl
          name="mode"
          data={[
            { label: 'Standard', value: KlingMode.STANDARD },
            { label: 'Professional', value: KlingMode.PROFESSIONAL },
          ]}
        />
      </div>
      <InputNumberSlider
        name="cfgScale"
        label={
          <div className="flex items-center gap-1">
            <Input.Label>CFG Scale</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 14 }}>
              Controls how closely the video generation follows the text prompt.{' '}
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
        min={0.1}
        max={1}
        step={0.1}
        precision={1}
        reverse
      />
    </FormWrapper>
  );
}

function KlingImageToVideoForm() {
  return (
    <FormWrapper engine="kling">
      {/* <InputImageUrl name="sourceImage" label="Image" /> */}
      <InputTextArea name="prompt" label="Prompt" placeholder="Your prompt goes here..." autosize />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={klingDuration.map((value) => ({
            label: `${value}s`,
            value,
          }))}
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <Input.Label>Mode</Input.Label>
          <InfoPopover size="xs" iconProps={{ size: 14 }}>
            Standard mode is faster to generate and more cost-effective. Pro takes longer to
            generate and has higher quality video output.
          </InfoPopover>
        </div>
        <InputSegmentedControl
          name="mode"
          data={[
            { label: 'Standard', value: KlingMode.STANDARD },
            { label: 'Professional', value: KlingMode.PROFESSIONAL },
          ]}
        />
      </div>
      <InputNumberSlider
        name="cfgScale"
        label={
          <div className="flex items-center gap-1">
            <Input.Label>CFG Scale</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 14 }}>
              Controls how closely the video generation follows the text prompt.{' '}
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
        min={0}
        max={1}
        step={0.1}
        precision={1}
        reverse
      />
    </FormWrapper>
  );
}

function HaiperTxt2VidGenerationForm() {
  return (
    <FormWrapper engine="haiper">
      <InputTextArea
        required
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
      <HaiperAspectRatio name="aspectRatio" label="Aspect Ratio" />
      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={haiperDuration.map((value) => ({ label: `${value}s`, value }))}
        />
      </div>
      <InputSeed name="seed" label="Seed" />
    </FormWrapper>
  );
}

function HaiperImg2VidGenerationForm() {
  return (
    <FormWrapper engine="haiper">
      {/* <InputImageUrl name="sourceImage" label="Image" /> */}
      <InputTextArea name="prompt" label="Prompt" placeholder="Your prompt goes here..." autosize />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={haiperDuration.map((value) => ({ label: `${value}s`, value }))}
        />
      </div>
      <InputSeed name="seed" label="Seed" />
    </FormWrapper>
  );
}

function MochiGenerationForm() {
  return (
    <FormWrapper engine="mochi">
      <InputTextArea
        required
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
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

function MinimaxTxt2VidGenerationForm() {
  return (
    <FormWrapper engine="minimax">
      <InputTextArea
        required
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
    </FormWrapper>
  );
}

function MinimaxImg2VidGenerationForm() {
  return (
    <FormWrapper engine="minimax">
      <InputTextArea name="prompt" label="Prompt" placeholder="Your prompt goes here..." autosize />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
    </FormWrapper>
  );
}

function LightricksPromptDescription() {
  const url =
    'https://education.civitai.com/civitais-quickstart-guide-to-lightricks-ltxv/#prompting';
  return (
    <span>
      If you see poor results, please refer to the{' '}
      <Anchor href={url} target="_blank">
        prompt guide
      </Anchor>
    </span>
  );
}
function LightricksTxt2VidGenerationForm() {
  return (
    <FormWrapper engine="lightricks">
      <InputTextArea
        required
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
        description={LightricksPromptDescription()}
      />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
      <InputAspectRatioColonDelimited
        name="aspectRatio"
        label="Aspect Ratio"
        options={lightricksAspectRatios}
      />
      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={lightricksDuration.map((value) => ({
            label: `${value}s`,
            value,
          }))}
        />
      </div>
      <InputNumberSlider
        name="cfgScale"
        label={
          <div className="flex items-center gap-1">
            <Input.Label>CFG Scale</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 14 }}>
              Controls how closely the video generation follows the text prompt.{' '}
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
        min={3}
        max={3.5}
        step={0.1}
        precision={1}
        reverse
      />

      <InputNumberSlider
        name="steps"
        label={
          <div className="flex items-center gap-1">
            <Input.Label>Steps</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 14 }}>
              The number of iterations spent generating a video.{' '}
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
        min={20}
        max={40}
        reverse
      />
      <InputSeed name="seed" label="Seed" />
    </FormWrapper>
  );
}

function LightricksImg2VidGenerationForm() {
  return (
    <FormWrapper engine="lightricks">
      <InputTextArea
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
        description={LightricksPromptDescription()}
      />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={lightricksDuration.map((value) => ({
            label: `${value}s`,
            value,
          }))}
        />
      </div>
      <InputNumberSlider
        name="cfgScale"
        label={
          <div className="flex items-center gap-1">
            <Input.Label>CFG Scale</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 14 }}>
              Controls how closely the video generation follows the text prompt.{' '}
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
        min={3}
        max={3.5}
        step={0.1}
        precision={1}
        reverse
      />

      <InputNumberSlider
        name="steps"
        label={
          <div className="flex items-center gap-1">
            <Input.Label>Steps</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 14 }}>
              The number of iterations spent generating a video.{' '}
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
        min={20}
        max={40}
        reverse
      />
      <InputSeed name="seed" label="Seed" />
    </FormWrapper>
  );
}

function FormWrapper({
  engine,
  children,
}: {
  engine: OrchestratorEngine;
  children: React.ReactNode | ((form: UseFormReturn) => React.ReactNode);
}) {
  const type = useGenerationFormStore((state) => state.type);
  const storeData = useGenerationStore((state) => state.data);
  const { workflow } = useWorkflowContext();
  const status = useGenerationStatus();
  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : undefined),
    [status.message]
  );

  const form = usePersistForm(workflow.key, {
    schema: z.record(z.string(), z.any()) as any,
    version: 1,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    defaultValues: validateInput(workflow),
    storage: localStorage,
  });

  const { availableEngines } = useVideoGenerationWorkflows();
  const { mutate, isLoading, error } = useGenerate();
  const [debouncedIsLoading, setDebouncedIsLoading] = useState(false);
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
    form.reset();
    generationFormStore.reset();
    generationFormStore.setEngine(availableEngines[0].key);
  }

  function handleSubmit(data: VideoGenerationSchema) {
    if (isLoading) return;
    setDebouncedIsLoading(true);

    const { cost } = useCostStore.getState();
    const totalCost = cost;
    // TODO - tips?
    conditionalPerformTransaction(totalCost, () => {
      mutate({
        type: 'video',
        data: validateInput(workflow, data),
        tags: [WORKFLOW_TAGS.VIDEO, workflow.subType, workflow.key],
      });
    });
    // if the workflow uses the same input, it will be short-circuited and the workflow will return an immediate success.
    // use `debouncedIsLoading` to better show that a submission has occurred
    setTimeout(() => {
      setDebouncedIsLoading(false);
    }, 1000);
  }

  useEffect(() => {
    if (type === 'video' && storeData && workflow) {
      const registered = Object.keys(form.getValues());
      const { params } = storeData;
      const validated = validateInput(workflow, params);
      for (const [key, value] of Object.entries(validated)) {
        if (registered.includes(key) && key !== 'engine') form.setValue(key as any, value);
      }
      generationStore.clearData();
    }
  }, [storeData, type, workflow]);

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
        <InputRequestPriority name="priority" label="Request Priority" modifier="multiplier" />
      </div>
      <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
        <DailyBoostRewardClaim />
        <QueueSnackbar />
        <div className="flex gap-2">
          <SubmitButton2 loading={isLoading || debouncedIsLoading} engine={engine} />
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

function SubmitButton2({ loading, engine }: { loading: boolean; engine: OrchestratorEngine }) {
  const [query, setQuery] = useState<Record<string, any> | null>(null);
  const { getValues, watch } = useFormContext();
  const [error, setError] = useState<string | null>(null);
  const isUploadingImageValue = useIsMutating({
    mutationKey: getQueryKey(trpc.orchestrator.imageUpload),
  });
  const isUploadingImage = isUploadingImageValue === 1;
  const { data, isFetching } = trpc.orchestrator.whatIf.useQuery(
    { type: 'video', data: query as Record<string, any> },
    { keepPreviousData: false, enabled: !!query && !isUploadingImage }
  );

  const { workflow } = useWorkflowContext();

  const cost = data?.cost?.total ?? 0;
  const totalCost = cost; //variable placeholder to allow adding tips // TODO - include tips in whatif query

  useEffect(() => {
    const { whatIf = [] } = engineDefinitions[engine] ?? {};
    // const { defaultValues } = workflow;
    const subscription = watch(() => {
      const formData = getValues();
      const whatIfData = whatIf.reduce<Record<string, unknown>>(
        (acc, prop) => ({ ...acc, [prop]: formData[prop] }),
        {}
      );

      try {
        const result = validateInput(workflow, { ...whatIfData, priority: formData.priority });
        setQuery(result);
        setError(null);
      } catch (e: any) {
        const { message, path } = JSON.parse(e.message)?.[0] as any;
        setQuery(null);
        setError(`${path?.[0]}: ${message}`);
      }
    });
    return subscription.unsubscribe;
  }, [workflow, engine]);

  useEffect(() => {
    if (data?.cost?.base) {
      useCostStore.setState({ cost: data.cost.base });
    }
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

const useCostStore = create<{ cost: number }>(() => ({ cost: 0 }));

function validateInput<TSchema extends z.AnyZodObject>(
  workflow: VideoGenerationConfig<TSchema>,
  data?: Record<string, unknown>
) {
  const { sourceImage, width, height } = useGenerationFormStore.getState();

  return workflow.schema.parse({
    ...data,
    engine: workflow.engine,
    workflow: workflow.key,
    sourceImage: sourceImage,
    width,
    height,
    type: workflow.subType,
  });
}
