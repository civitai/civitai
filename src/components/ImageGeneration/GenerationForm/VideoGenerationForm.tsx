import { Button, Input, Title, Text, ActionIcon } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useFormContext, useFormState } from 'react-hook-form';
import { z } from 'zod';
import { DailyBoostRewardClaim } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { HaiperAspectRatio } from '~/components/ImageGeneration/GenerationForm/HaiperAspectRatio';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { Form, InputSegmentedControl, InputSelect, InputText, InputTextArea } from '~/libs/form';
import { usePersistForm } from '~/libs/form/hooks/usePersistForm';
import {
  videoGenerationSchema,
  haiperVideoGenerationSchema,
} from '~/server/schema/orchestrator/orchestrator.schema';
import { trpc } from '~/utils/trpc';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { useGenerate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import { create } from 'zustand';
import { generationStore, useGenerationStore } from '~/store/generation.store';
import { titleCase } from '~/utils/string-helpers';
import { IconX } from '@tabler/icons-react';

const schema = haiperVideoGenerationSchema;
const defaultValues = {
  prompt: '',
  negativePrompt: '',
  engine: 'haiper',
  cameraMovement: 'none',
  aspectRatio: '1:1',
  duration: 4,
} as const;

export function VideoGenerationForm() {
  const type = useGenerationStore((state) => state.type);
  const storeData = useGenerationStore((state) => state.data);

  const form = usePersistForm('video-generation', {
    schema,
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
    conditionalPerformTransaction(totalCost, () =>
      mutate({ type: 'video', data, tags: ['txt2vid'] })
    );
  }

  useEffect(() => {
    if (type === 'video' && storeData) {
      const { params } = storeData;
      for (const [key, value] of Object.entries(params)) {
        form.setValue(key as any, value);
      }
      generationStore.clearData();
    }
  }, [storeData, type]);

  const engine = form.watch('engine');
  const image = form.watch('sourceImageUrl');

  return (
    <Form
      form={form}
      className="relative flex h-full flex-1 flex-col overflow-hidden"
      onSubmit={handleSubmit}
    >
      <ScrollArea scrollRestore={{ key: 'generation-form' }} className="flex flex-col gap-2 p-2">
        <div>
          <Title order={2}>{titleCase(engine)}</Title>
          <Text size="sm">{engineText[engine]}</Text>
        </div>
        <InputText name="engine" hidden clearable={false} />
        <InputText name="sourceImageUrl" hidden clearable={false} />
        {image && (
          <div>
            <div className="relative inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image}
                alt="image to refine"
                className="max-w-40 rounded-md shadow-sm shadow-black"
              />
              <ActionIcon
                variant="light"
                size="sm"
                color="red"
                radius="xl"
                className="absolute -right-2 -top-2"
                onClick={() => form.setValue('sourceImageUrl', undefined)}
              >
                <IconX size={16} strokeWidth={2.5} />
              </ActionIcon>
            </div>
          </div>
        )}
        <InputTextArea
          name="prompt"
          label="Prompt"
          placeholder="Your prompt goes here..."
          autosize
          required={!image}
        />
        <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
        <HaiperAspectRatio name="aspectRatio" label="Aspect Ratio" />
        <InputSelect
          name="cameraMovement"
          label="Camera Movement"
          data={[
            { label: 'none', value: 'none' },
            { label: 'pan right', value: 'panRight' },
            { label: 'pan left', value: 'panLeft' },
            { label: 'tilt up', value: 'tiltUp' },
            { label: 'tilt down', value: 'tiltDown' },
            { label: 'zoom in', value: 'zoomIn' },
            { label: 'zoom out', value: 'zoomOut' },
          ]}
        />
        <div className="flex flex-col gap-0.5">
          <Input.Label>Duration</Input.Label>
          <InputSegmentedControl
            name="duration"
            data={[2, 4, 8].map((value) => ({ label: `${value}s`, value }))}
          />
        </div>
        <InputSeed name="seed" label="Seed" />
      </ScrollArea>
      <div className="shadow-topper flex flex-col gap-2 rounded-xl p-2">
        <DailyBoostRewardClaim />
        <div className="flex gap-2">
          <SubmitButton loading={isLoading} />
          <Button onClick={handleReset} variant="default" className="h-auto px-3">
            Reset
          </Button>
        </div>
      </div>
    </Form>
  );
}

function SubmitButton({ loading }: { loading: boolean }) {
  const [query, setQuery] = useState<z.infer<typeof schema> | null>(null);
  const { control, getValues, watch } = useFormContext<z.infer<typeof schema>>();
  const { isValid } = useFormState({ control });
  const { data, isFetching } = trpc.orchestrator.whatIf.useQuery(
    { type: 'video', data: query as z.infer<typeof schema> },
    { keepPreviousData: false, enabled: isValid && !!query }
  );

  const cost = data?.cost?.total ?? 0;
  const totalCost = cost; //variable placeholder to allow adding tips // TODO - include tips in whatif query

  useEffect(() => {
    const subscription = watch(() => {
      setQuery({
        ...defaultValues,
        ...getValues(),
        prompt: 'whatIf',
        negativePrompt: undefined,
        seed: undefined,
        aspectRatio: '1:1',
      });
    });
    return subscription.unsubscribe;
  }, [isValid]);

  useEffect(() => {
    if (data?.cost?.base) {
      useCostStore.setState({ cost: data.cost.base });
    }
  }, [data]);

  return (
    <GenerateButton
      type="submit"
      className="flex-1"
      disabled={!data || !isValid}
      loading={isFetching || loading}
      cost={totalCost}
    >
      Generate
    </GenerateButton>
  );
}

const useCostStore = create<{ cost: number }>(() => ({ cost: 0 }));

const engineText = {
  haiper: `Haiper is a video and image AI platform building its own powerful foundation model. Haiper's next-gen 2.0 model generates hyper-realistic and stunning images and videos that can be enhanced and extended.`,
};
