import { Button, Input, Text, Select } from '@mantine/core';
import React, { useEffect, useState } from 'react';
import { UseFormReturn, useFormContext } from 'react-hook-form';
import { z } from 'zod';
import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { HaiperAspectRatio } from '~/components/ImageGeneration/GenerationForm/HaiperAspectRatio';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { Form, InputSegmentedControl, InputText, InputTextArea } from '~/libs/form';
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
import { generationStore, useGenerationStore } from '~/store/generation.store';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { showErrorNotification } from '~/utils/notifications';
import { InputImageUrl } from '~/components/Generate/Input/InputImageUrl';
import { useLocalStorage } from '@mantine/hooks';
import { Watch } from '~/libs/form/components/Watch';

const schema = videoGenerationSchema;

export function VideoGenerationForm() {
  const [engine, setEngine] = useLocalStorage<Engine>({
    key: 'engine',
    defaultValue: 'haiper',
    getInitialValueInEffect: false,
  });

  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="px-3">
        <Select
          label="Engine"
          value={engine}
          onChange={(value) => setEngine(value as Engine)}
          data={['haiper', 'mochi']}
        />
      </div>
      <EngineForm engine={engine} />
    </div>
  );
}

function EngineForm({ engine }: { engine: Engine }) {
  switch (engine) {
    case 'haiper':
      return <HaiperGenerationForm />;
    case 'mochi':
      return <MochiGenerationForm />;
    default:
      return null;
  }
}

function HaiperGenerationForm() {
  return (
    <FormWrapper engine="haiper">
      <InputImageUrl name="sourceImageUrl" label="Image" />
      <InputTextArea name="prompt" label="Prompt" placeholder="Your prompt goes here..." autosize />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
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

function MochiGenerationForm() {
  return (
    <FormWrapper engine="mochi">
      <InputTextArea name="prompt" label="Prompt" placeholder="Your prompt goes here..." autosize />
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
  const type = useGenerationStore((state) => state.type);
  const storeData = useGenerationStore((state) => state.data);
  const { defaultValues } = engines[engine] ?? {};

  const form = usePersistForm(`video-generation-${engine}`, {
    schema: schema as any,
    version: 1,
    reValidateMode: 'onSubmit',
    mode: 'onSubmit',
    defaultValues,
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
    form.reset(defaultValues);
  }

  function handleSubmit(data: z.infer<typeof schema>) {
    if (isLoading) return;

    const { cost } = useCostStore.getState();
    const totalCost = cost;
    // TODO - tips?
    conditionalPerformTransaction(totalCost, () => {
      const tags = [WORKFLOW_TAGS.IMAGE, WORKFLOW_TAGS.VIDEO];
      if (data.engine === 'haiper') {
        const tag = data.sourceImageUrl ? 'img2vid' : 'txt2vid';
        mutate({ type: 'video', data, tags: [...tags, tag] });
      } else if (data.engine === 'mochi') {
        const tag = 'txt2vid';
        mutate({
          type: 'video',
          data: { engine: data.engine, prompt: data.prompt, seed: data.seed },
          tags: [...tags, tag],
        });
      }
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
      className="relative flex h-full flex-1 flex-col justify-between gap-2"
    >
      <div className="flex flex-col gap-2 px-3">
        <InputText type="hidden" name="engine" value={engine} />
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

  const cost = data?.cost?.total ?? 0;
  const totalCost = cost; //variable placeholder to allow adding tips // TODO - include tips in whatif query

  useEffect(() => {
    const { whatIf = [], defaultValues } = engines[engine] ?? {};
    const subscription = watch(() => {
      const formData = getValues();
      const whatIfData = whatIf.reduce<Record<string, unknown>>(
        (acc, prop) => ({ ...acc, [prop]: formData[prop] }),
        {}
      );

      const result = schema.safeParse({ ...defaultValues, ...whatIfData });
      if (!result.success) setQuery(null);
      else setQuery(result.data);
    });
    return subscription.unsubscribe;
  }, [engine]);

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
    defaultValues: VideoGenerationInput;
    whatIf?: string[];
  }
>;
const engines: EnginesDictionary = {
  haiper: {
    label: 'Haiper',
    description: `Generate hyper-realistic and stunning videos with Haiper's next-gen 2.0 model!`,
    defaultValues: {
      engine: 'haiper',
      prompt: '',
      negativePrompt: '',
      aspectRatio: '1:1',
      duration: 4,
    },
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
    defaultValues: {
      engine: 'mochi',
      prompt: '',
    },
  },
};
