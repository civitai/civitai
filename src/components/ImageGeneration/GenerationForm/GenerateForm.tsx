import {
  Card,
  Group,
  NumberInputProps,
  SliderProps,
  Stack,
  Text,
  Button,
  CardProps,
} from '@mantine/core';
import { UseFormReturn } from 'react-hook-form';
import { Form, InputNumberSlider, InputSwitch, InputTextArea } from '~/libs/form';
import { GenerateFormModel } from '~/server/schema/generation.schema';

export function GenerateForm({ form }: { form: UseFormReturn<GenerateFormModel> }) {
  return (
    <Form form={form} onSubmit={(data) => console.log({ data })}>
      <Stack>
        <Card {...sharedCardProps}>
          <Stack>
            {/* TODO.resources */}
            <InputTextArea name="prompt" label="Prompt" withAsterisk />
            <InputTextArea name="negativePrompt" label="Negative Prompt" />
            <InputSwitch
              name="nsfw"
              label="Mature content"
              labelPosition="left"
              wrapperProps={{ style: { display: 'flex', justifyContent: 'space-between' } }}
            />
          </Stack>
        </Card>
        <Card {...sharedCardProps}>
          <Stack>
            <Text>TODO.aspect ratio </Text>
            <Text>TODO.advanced settings</Text>
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
          </Stack>
        </Card>
        <Card {...sharedCardProps}>
          <Stack>
            <Text>TODO.hires</Text>
          </Stack>
        </Card>
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

const clipSkipMarks = Array(10)
  .fill(0)
  .map((_, index) => ({ value: index + 1 }));
