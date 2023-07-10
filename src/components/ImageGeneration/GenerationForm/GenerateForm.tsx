import {
  Card,
  Group,
  NumberInputProps,
  SliderProps,
  Stack,
  Text,
  Button,
  CardProps,
  Center,
  Paper,
  Input,
  Accordion,
  Divider,
} from '@mantine/core';
import { ModelType } from '@prisma/client';
import { Key, useEffect, useRef } from 'react';
import { UseFormReturn } from 'react-hook-form';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import InputResourceSelect from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import InputResourceSelectMultiple from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import { PersistantAccordion } from '~/components/PersistantAccordion/PersistantAccordion';
import {
  Form,
  InputNumberSlider,
  InputSegmentedControl,
  InputSelect,
  InputSwitch,
  InputTextArea,
} from '~/libs/form';
import { GenerateFormModel, MAX_SEED, supportedSamplers } from '~/server/schema/generation.schema';
import { getDisplayName } from '~/utils/string-helpers';

export function GenerateForm({ form }: { form: UseFormReturn<GenerateFormModel> }) {
  const baseModelRef = useRef<string[]>();

  useEffect(() => {
    const subscription = form.watch((value, { name, type }) => {
      // do things with the form here (remove values, add values)
      // TODO - basemodel stuff
      // console.log({ value, name, type });
      // reset emits an empty value object (value = {})
    });
    return () => subscription.unsubscribe();
  }, []); //eslint-disable-line

  return (
    <Form form={form} onSubmit={(data) => console.log({ data })}>
      <Stack>
        <Card {...sharedCardProps}>
          <Stack>
            <InputResourceSelect
              name="model"
              type={ModelType.Checkpoint}
              label="Model"
              buttonLabel="Add Model"
              withAsterisk
              baseModels={baseModelRef.current}
            />
            <InputResourceSelectMultiple
              name="resources"
              limit={9}
              groups={[
                {
                  type: ModelType.LORA,
                  label: getDisplayName(ModelType.LORA),
                },
                {
                  type: ModelType.TextualInversion,
                  label: getDisplayName(ModelType.TextualInversion),
                },
              ]}
              buttonLabel="Add additional resource"
              baseModels={baseModelRef.current}
            />
            <InputTextArea name="prompt" label="Prompt" withAsterisk autosize />
            <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
            <InputSwitch name="nsfw" label="Mature content" labelPosition="left" />
          </Stack>
        </Card>
        <Card {...sharedCardProps}>
          <Stack>
            <Stack spacing={0}>
              <Input.Label>Aspect Ratio</Input.Label>
              <InputSegmentedControl name="aspectRatio" data={aspectRatioControls} />
            </Stack>
            <PersistantAccordion
              storeKey="generation-form-advanced"
              variant="filled"
              styles={(theme) => ({
                content: {
                  padding: 0,
                },
                item: {
                  overflow: 'hidden',
                  border: 'none',
                  background: 'transparent',
                },
                control: {
                  padding: 0,
                  paddingBottom: theme.spacing.xs,
                },
              })}
            >
              <Accordion.Item value="advanced">
                <Accordion.Control>
                  <Divider
                    label="Advanced"
                    labelPosition="left"
                    labelProps={{ size: 'sm', weight: 500 }}
                  />
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack>
                    <InputSelect name="sampler" label="Sampler" data={[...supportedSamplers]} />
                    <Group position="apart">
                      <InputNumberSlider
                        name="steps"
                        label="Steps"
                        min={1}
                        max={150}
                        sliderProps={sharedSliderProps}
                        numberProps={sharedNumberProps}
                      />
                      <InputNumberSlider
                        name="cfgScale"
                        label="CFG Scale"
                        min={1}
                        max={30}
                        step={0.5}
                        precision={1}
                        sliderProps={sharedSliderProps}
                        numberProps={sharedNumberProps}
                      />
                    </Group>
                    <InputSeed name="seed" label="Seed" min={1} max={MAX_SEED} />
                    <InputNumberSlider
                      name="clipSkip"
                      label="Clip Skip"
                      min={0}
                      max={10}
                      sliderProps={{
                        ...sharedSliderProps,
                        marks: clipSkipMarks,
                      }}
                      numberProps={sharedNumberProps}
                    />
                    <InputResourceSelect
                      name="vae"
                      type={ModelType.VAE}
                      label={getDisplayName(ModelType.VAE)}
                      buttonLabel="Add VAE"
                    />
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </PersistantAccordion>
          </Stack>
        </Card>
        {/* <Card {...sharedCardProps}>
          <Stack>
            <Text>TODO.hires</Text>
          </Stack>
        </Card> */}
        <Card {...sharedCardProps}>
          <Button type="submit">Submit</Button>
        </Card>
      </Stack>
    </Form>
  );
}

const sharedCardProps: Omit<CardProps, 'children'> = {
  withBorder: true,
};

const sharedSliderProps: SliderProps = {
  size: 'sm',
};

const sharedNumberProps: NumberInputProps = {
  size: 'sm',
};

const aspectRatios = [
  { label: 'Square', width: 512, height: 512 },
  { label: 'Landscape', width: 768, height: 512 },
  { label: 'Portrait', width: 512, height: 768 },
];

const aspectRatioControls = aspectRatios.map(({ label, width, height }) => ({
  label: (
    <Stack spacing={2}>
      <Center>
        <Paper withBorder sx={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 20 }} />
      </Center>
      <Stack spacing={0}>
        <Text size="xs">{label}</Text>
        <Text size={10} color="dimmed">{`${width}x${height}`}</Text>
      </Stack>
    </Stack>
  ),
  value: `${width}x${height}`,
}));

const clipSkipMarks = Array(10)
  .fill(0)
  .map((_, index) => ({ value: index + 1 }));
